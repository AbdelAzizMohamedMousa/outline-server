// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as sentry from '@sentry/electron';
import * as semver from 'semver';

import * as digitalocean_api from '../cloud/digitalocean_api';
import * as errors from '../infrastructure/errors';
import {sleep} from '../infrastructure/sleep';
import * as accounts from '../model/accounts';
import * as digitalocean from '../model/digitalocean';
import * as gcp from '../model/gcp';
import * as server from '../model/server';

import {DisplayDataAmount, displayDataAmountToBytes,} from './data_formatting';
import * as digitalocean_server from './digitalocean_server';
import {parseManualServerConfig} from './management_urls';
import {AccountListEntry, AppRoot, ServerListEntry} from './ui_components/app-root';
import {Location} from './ui_components/outline-region-picker-step';
import {DisplayAccessKey, ServerView} from './ui_components/outline-server-view';

// The Outline DigitalOcean team's referral code:
//   https://www.digitalocean.com/help/referral-program/
const UNUSED_DIGITALOCEAN_REFERRAL_CODE = '5ddb4219b716';

const CHANGE_KEYS_PORT_VERSION = '1.0.0';
const DATA_LIMITS_VERSION = '1.1.0';
const CHANGE_HOSTNAME_VERSION = '1.2.0';
const KEY_SETTINGS_VERSION = '1.6.0';
const MAX_ACCESS_KEY_DATA_LIMIT_BYTES = 50 * (10 ** 9);  // 50GB
const CANCELLED_ERROR = new Error('Cancelled');
export const LAST_DISPLAYED_SERVER_STORAGE_KEY = 'lastDisplayedServer';

// DigitalOcean mapping of regions to flags
const FLAG_IMAGE_DIR = 'images/flags';
const DIGITALOCEAN_FLAG_MAPPING: {[cityId: string]: string} = {
  ams: `${FLAG_IMAGE_DIR}/netherlands.png`,
  sgp: `${FLAG_IMAGE_DIR}/singapore.png`,
  blr: `${FLAG_IMAGE_DIR}/india.png`,
  fra: `${FLAG_IMAGE_DIR}/germany.png`,
  lon: `${FLAG_IMAGE_DIR}/uk.png`,
  sfo: `${FLAG_IMAGE_DIR}/us.png`,
  tor: `${FLAG_IMAGE_DIR}/canada.png`,
  nyc: `${FLAG_IMAGE_DIR}/us.png`,
};

function displayDataAmountToDataLimit(dataAmount: DisplayDataAmount): server.DataLimit|null {
  if (!dataAmount) {
    return null;
  }

  return {bytes: displayDataAmountToBytes(dataAmount)};
}

// Compute the suggested data limit based on the server's transfer capacity and number of access
// keys.
async function computeDefaultDataLimit(
    server: server.Server, accessKeys?: server.AccessKey[]): Promise<server.DataLimit> {
  try {
    // Assume non-managed servers have a data transfer capacity of 1TB.
    let serverTransferCapacity: server.DataAmount = {terabytes: 1};
    if (isManagedServer(server)) {
      serverTransferCapacity = server.getHost().getMonthlyOutboundTransferLimit();
    }
    if (!accessKeys) {
      accessKeys = await server.listAccessKeys();
    }
    let dataLimitBytes = serverTransferCapacity.terabytes * (10 ** 12) / (accessKeys.length || 1);
    if (dataLimitBytes > MAX_ACCESS_KEY_DATA_LIMIT_BYTES) {
      dataLimitBytes = MAX_ACCESS_KEY_DATA_LIMIT_BYTES;
    }
    return {bytes: dataLimitBytes};
  } catch (e) {
    console.error(`Failed to compute default access key data limit: ${e}`);
    return {bytes: MAX_ACCESS_KEY_DATA_LIMIT_BYTES};
  }
}

// Returns whether the user has seen a notification for the updated feature metrics data collection
// policy.
function hasSeenFeatureMetricsNotification(): boolean {
  return !!window.localStorage.getItem('dataLimitsHelpBubble-dismissed') &&
      !!window.localStorage.getItem('dataLimits-feature-collection-notification');
}

async function showHelpBubblesOnce(serverView: ServerView) {
  if (!window.localStorage.getItem('addAccessKeyHelpBubble-dismissed')) {
    await serverView.showAddAccessKeyHelpBubble();
    window.localStorage.setItem('addAccessKeyHelpBubble-dismissed', 'true');
  }
  if (!window.localStorage.getItem('getConnectedHelpBubble-dismissed')) {
    await serverView.showGetConnectedHelpBubble();
    window.localStorage.setItem('getConnectedHelpBubble-dismissed', 'true');
  }
  if (!window.localStorage.getItem('dataLimitsHelpBubble-dismissed') &&
      serverView.supportsDefaultDataLimit) {
    await serverView.showDataLimitsHelpBubble();
    window.localStorage.setItem('dataLimitsHelpBubble-dismissed', 'true');
  }
}

function isManagedServer(testServer: server.Server): testServer is server.ManagedServer {
  return !!(testServer as server.ManagedServer).getHost;
}

function isManualServer(testServer: server.Server): testServer is server.ManualServer {
  return !!(testServer as server.ManualServer).forget;
}

export class App {
  private digitalOceanAccount: digitalocean.Account;
  private gcpAccount: gcp.Account;
  private selectedServer: server.Server;
  private idServerMap = new Map<string, server.Server>();

  constructor(
      private appRoot: AppRoot, private readonly version: string,
      private manualServerRepository: server.ManualServerRepository,
      private cloudAccounts: accounts.CloudAccounts) {
    appRoot.setAttribute('outline-version', this.version);

    appRoot.addEventListener('ConnectDigitalOceanAccountRequested', (event: CustomEvent) => {
      this.handleConnectDigitalOceanAccountRequest();
    });
    appRoot.addEventListener('CreateDigitalOceanServerRequested', (event: CustomEvent) => {
      const digitalOceanAccount = this.cloudAccounts.getDigitalOceanAccount();
      if (digitalOceanAccount) {
        this.showDigitalOceanCreateServer(digitalOceanAccount);
      } else {
        console.error('Access token not found for server creation');
        this.handleConnectDigitalOceanAccountRequest();
      }
    });
    appRoot.addEventListener(
        'ConnectGcpAccountRequested',
        async (event: CustomEvent) => this.handleConnectGcpAccountRequest());
    appRoot.addEventListener(
        'CreateGcpServerRequested',
        async (event: CustomEvent) => console.log('Received CreateGcpServerRequested event'));
    appRoot.addEventListener('DigitalOceanSignOutRequested', (event: CustomEvent) => {
      this.disconnectDigitalOceanAccount();
      this.showIntro();
    });
    appRoot.addEventListener('GcpSignOutRequested', (event: CustomEvent) => {
      this.disconnectGcpAccount();
      this.showIntro();
    });

    appRoot.addEventListener('SetUpServerRequested', (event: CustomEvent) => {
      this.createDigitalOceanServer(event.detail.regionId);
    });

    appRoot.addEventListener('DeleteServerRequested', (event: CustomEvent) => {
      this.deleteSelectedServer();
    });

    appRoot.addEventListener('ForgetServerRequested', (event: CustomEvent) => {
      this.forgetSelectedServer();
    });

    appRoot.addEventListener('AddAccessKeyRequested', (event: CustomEvent) => {
      this.addAccessKey();
    });

    appRoot.addEventListener('RemoveAccessKeyRequested', (event: CustomEvent) => {
      this.removeAccessKey(event.detail.accessKeyId);
    });

    appRoot.addEventListener(
        'OpenPerKeyDataLimitDialogRequested', this.openPerKeyDataLimitDialog.bind(this));

    appRoot.addEventListener('RenameAccessKeyRequested', (event: CustomEvent) => {
      this.renameAccessKey(event.detail.accessKeyId, event.detail.newName, event.detail.entry);
    });

    appRoot.addEventListener('SetDefaultDataLimitRequested', (event: CustomEvent) => {
      this.setDefaultDataLimit(displayDataAmountToDataLimit(event.detail.limit));
    });

    appRoot.addEventListener('RemoveDefaultDataLimitRequested', (event: CustomEvent) => {
      this.removeDefaultDataLimit();
    });

    appRoot.addEventListener('ChangePortForNewAccessKeysRequested', (event: CustomEvent) => {
      this.setPortForNewAccessKeys(event.detail.validatedInput, event.detail.ui);
    });

    appRoot.addEventListener('ChangeHostnameForAccessKeysRequested', (event: CustomEvent) => {
      this.setHostnameForAccessKeys(event.detail.validatedInput, event.detail.ui);
    });

    // The UI wants us to validate a server management URL.
    // "Reply" by setting a field on the relevant template.
    appRoot.addEventListener('ManualServerEdited', (event: CustomEvent) => {
      let isValid = true;
      try {
        parseManualServerConfig(event.detail.userInput);
      } catch (e) {
        isValid = false;
      }
      const manualServerEntryEl = appRoot.getManualServerEntry();
      manualServerEntryEl.enableDoneButton = isValid;
    });

    appRoot.addEventListener('ManualServerEntered', (event: CustomEvent) => {
      const userInput = event.detail.userInput;
      const manualServerEntryEl = appRoot.getManualServerEntry();
      this.createManualServer(userInput)
          .then(() => {
            // Clear fields on outline-manual-server-entry (e.g. dismiss the connecting popup).
            manualServerEntryEl.clear();
          })
          .catch((e: Error) => {
            // Remove the progress indicator.
            manualServerEntryEl.showConnection = false;
            // Display either error dialog or feedback depending on error type.
            if (e instanceof errors.UnreachableServerError) {
              const errorTitle = appRoot.localize('error-server-unreachable-title');
              const errorMessage = appRoot.localize('error-server-unreachable');
              this.appRoot.showManualServerError(errorTitle, errorMessage);
            } else {
              // TODO(alalama): with UI validation, this code path never gets executed. Remove?
              let errorMessage = '';
              if (e.message) {
                errorMessage += `${e.message}\n`;
              }
              if (userInput) {
                errorMessage += userInput;
              }
              appRoot.openManualInstallFeedback(errorMessage);
            }
          });
    });

    appRoot.addEventListener('EnableMetricsRequested', (event: CustomEvent) => {
      this.setMetricsEnabled(true);
    });

    appRoot.addEventListener('DisableMetricsRequested', (event: CustomEvent) => {
      this.setMetricsEnabled(false);
    });

    appRoot.addEventListener('SubmitFeedback', (event: CustomEvent) => {
      const detail = event.detail;
      try {
        sentry.captureEvent({
          message: detail.userFeedback,
          user: {email: detail.userEmail},
          tags: {category: detail.feedbackCategory, cloudProvider: detail.cloudProvider}
        });
        appRoot.showNotification(appRoot.localize('notification-feedback-thanks'));
      } catch (e) {
        console.error(`Failed to submit feedback: ${e}`);
        appRoot.showError(appRoot.localize('error-feedback'));
      }
    });

    appRoot.addEventListener('SetLanguageRequested', (event: CustomEvent) => {
      this.setAppLanguage(event.detail.languageCode, event.detail.languageDir);
    });

    appRoot.addEventListener('ServerRenameRequested', (event: CustomEvent) => {
      this.renameServer(event.detail.newName);
    });

    appRoot.addEventListener('CancelServerCreationRequested', (event: CustomEvent) => {
      this.cancelServerCreation(this.selectedServer);
    });

    appRoot.addEventListener('OpenImageRequested', (event: CustomEvent) => {
      openImage(event.detail.imagePath);
    });

    appRoot.addEventListener('OpenShareDialogRequested', (event: CustomEvent) => {
      const accessKey = event.detail.accessKey;
      this.appRoot.openShareDialog(accessKey, this.getS3InviteUrl(accessKey));
    });

    appRoot.addEventListener('OpenGetConnectedDialogRequested', (event: CustomEvent) => {
      this.appRoot.openGetConnectedDialog(this.getS3InviteUrl(event.detail.accessKey, true));
    });

    appRoot.addEventListener('ShowServerRequested', (event: CustomEvent) => {
      const server = this.getServerById(event.detail.displayServerId);
      if (server) {
        this.showServer(server);
      } else {
        // This should never happen if we are managine the list correctly.
        console.error(
            `Could not find server for display server ID ${event.detail.displayServerId}`);
      }
    });

    onUpdateDownloaded(this.displayAppUpdateNotification.bind(this));
  }

  // Shows the intro screen with overview and options to sign in or sign up.
  private showIntro() {
    this.appRoot.showIntro();
  }

  private displayAppUpdateNotification() {
    this.appRoot.showNotification(this.appRoot.localize('notification-app-update'), 60000);
  }

  async start(): Promise<void> {
    this.showIntro();

    // Load connected accounts and servers.
    await Promise.all([
      this.loadDigitalOceanAccount(this.cloudAccounts.getDigitalOceanAccount()),
      this.loadGcpAccount(this.cloudAccounts.getGcpAccount()), this.loadManualServers()
    ]);

    // Show last displayed server, if any.
    const serverIdToSelect = localStorage.getItem(LAST_DISPLAYED_SERVER_STORAGE_KEY);
    if (serverIdToSelect) {
      const serverToShow = this.getServerById(serverIdToSelect);
      if (serverToShow) {
        this.showServer(serverToShow);
      }
    }
  }

  private async loadDigitalOceanAccount(digitalOceanAccount: digitalocean.Account):
      Promise<server.ManagedServer[]> {
    if (!digitalOceanAccount) {
      return [];
    }
    try {
      this.digitalOceanAccount = digitalOceanAccount;
      const accountListEntry: AccountListEntry = {
        name: await this.digitalOceanAccount.getName(),
        cloudProvider: 'DIGITALOCEAN',
      };
      this.appRoot.accountList = this.appRoot.accountList.concat([accountListEntry]);
      const status = await this.digitalOceanAccount.getStatus();
      if (status !== digitalocean.Status.ACTIVE) {
        return [];
      }
      const servers = await this.digitalOceanAccount.listServers();
      for (const server of servers) {
        this.addServer(server);
      }
      return servers;
    } catch (error) {
      // TODO(fortuna): Handle expired token.
      this.appRoot.showError(this.appRoot.localize('error-do-account-info'));
      console.error('Failed to load DigitalOcean Account:', error);
    }
    return [];
  }

  private async loadGcpAccount(gcpAccount: gcp.Account): Promise<server.ManagedServer[]> {
    if (!gcpAccount) {
      return [];
    }

    this.gcpAccount = gcpAccount;
    const accountListEntry: AccountListEntry = {
      name: await this.gcpAccount.getName(),
      cloudProvider: 'GCP',
    };
    this.appRoot.accountList = this.appRoot.accountList.concat([accountListEntry]);
    return [];
  }

  private async loadManualServers() {
    for (const server of await this.manualServerRepository.listServers()) {
      this.addServer(server);
    }
  }

  private makeServerListEntry(server: server.Server): ServerListEntry {
    // TODO: Set this to the appropriate cloud provider
    const cloudProvider = isManualServer(server) ? 'MANUAL' : 'DIGITALOCEAN';

    return {
      id: server.getId(),
      name: this.makeDisplayName(server),
      cloudProvider,
      isSynced: !!server.getName(),
    };
  }

  private makeDisplayName(server: server.Server): string {
    let name = server.getName() ?? server.getHostnameForAccessKeys();
    if (!name) {
      if (isManagedServer(server)) {
        // Newly created servers will not have a name.
        name = this.makeLocalizedServerName(server.getHost().getRegionId());
      }
    }
    return name;
  }

  private addServer(server: server.Server): void {
    console.log('Loading server', server);
    this.idServerMap.set(server.getId(), server);
    const serverEntry = this.makeServerListEntry(server);
    this.appRoot.serverList = this.appRoot.serverList.concat([serverEntry]);

    if (isManagedServer(server) && !server.isInstallCompleted()) {
      this.setServerProgressView(server);
    }

    // Once the server is added to the list, do the rest asynchronously.
    setTimeout(async () => {
      // Wait for server config to load, then update the server view and list.
      if (isManagedServer(server) && !server.isInstallCompleted()) {
        try {
          await server.waitOnInstall();
        } catch (error) {
          if (error instanceof errors.DeletedServerError) {
            // User clicked "Cancel" on the loading screen.
            return;
          }
          console.log('Server creation failed', error);
          this.appRoot.showError(this.appRoot.localize('error-server-creation'));
        }
      }
      await this.updateServerView(server);
      // This has to run after updateServerView because it depends on the isHealthy() call.
      // TODO(fortuna): Better handle state changes.
      this.updateServerEntry(server);
    }, 0);
  }

  private removeServer(serverId: string): void {
    this.idServerMap.delete(serverId);
    this.appRoot.serverList = this.appRoot.serverList.filter((ds) => ds.id !== serverId);
    if (this.appRoot.selectedServerId === serverId) {
      this.appRoot.selectedServerId = '';
      this.selectedServer = null;
      localStorage.removeItem(LAST_DISPLAYED_SERVER_STORAGE_KEY);
    }
  }

  private updateServerEntry(server: server.Server): void {
    this.appRoot.serverList = this.appRoot.serverList.map(
        (ds) => ds.id === server.getId() ? this.makeServerListEntry(server) : ds);
  }

  private getServerById(serverId: string): server.Server {
    return this.idServerMap.get(serverId);
  }

  // Returns a promise that resolves when the account is active.
  // Throws CANCELLED_ERROR on cancellation, and the error on failure.
  private async ensureActiveDigitalOceanAccount(digitalOceanAccount: digitalocean.Account):
      Promise<void> {
    let cancelled = false;
    let activatingAccount = false;

    // TODO(fortuna): Provide a cancel action instead of sign out.
    const signOutAction = () => {
      cancelled = true;
      this.disconnectDigitalOceanAccount();
    };
    const oauthUi = this.appRoot.getDigitalOceanOauthFlow(signOutAction);
    while (true) {
      const status = await this.digitalOceanRetry(async () => {
        if (cancelled) {
          throw CANCELLED_ERROR;
        }
        return await digitalOceanAccount.getStatus();
      });
      if (status === digitalocean.Status.ACTIVE) {
        bringToFront();
        if (activatingAccount) {
          // Show the 'account active' screen for a few seconds if the account was activated
          // during this session.
          oauthUi.showAccountActive();
          await sleep(1500);
        }
        return;
      }
      this.appRoot.showDigitalOceanOauthFlow();
      activatingAccount = true;
      if (status === digitalocean.Status.MISSING_BILLING_INFORMATION) {
        oauthUi.showBilling();
      } else {
        oauthUi.showEmailVerification();
      }
      await sleep(1000);
      if (this.appRoot.currentPage !== 'digitalOceanOauth') {
        // The user navigated away.
        cancelled = true;
      }
      if (cancelled) {
        throw CANCELLED_ERROR;
      }
    }
  }

  // Intended to add a "retry or re-authenticate?" prompt to DigitalOcean
  // operations. Specifically, any operation rejecting with an digitalocean_api.XhrError will
  // result in a dialog asking the user whether to retry the operation or
  // re-authenticate against DigitalOcean.
  // This is necessary because an access token may expire or be revoked at
  // any time and there's no way to programmatically distinguish network errors
  // from CORS-type errors (see the comments in DigitalOceanSession for more
  // information).
  // TODO: It would be great if, once the user has re-authenticated, we could
  //       return the UI to its exact prior state. Fortunately, the most likely
  //       time to discover an invalid access token is when the application
  //       starts.
  private digitalOceanRetry = <T>(f: () => Promise<T>): Promise<T> => {
    return f().catch((e) => {
      if (!(e instanceof digitalocean_api.XhrError)) {
        return Promise.reject(e);
      }

      return new Promise<T>((resolve, reject) => {
        this.appRoot.showConnectivityDialog((retry: boolean) => {
          if (retry) {
            this.digitalOceanRetry(f).then(resolve, reject);
          } else {
            this.disconnectDigitalOceanAccount();
            reject(e);
          }
        });
      });
    });
  };

  // Runs the DigitalOcean OAuth flow and returns the API access token.
  // Throws CANCELLED_ERROR on cancellation, or the error in case of failure.
  private async runDigitalOceanOauthFlow(): Promise<string> {
    const oauth = runDigitalOceanOauth();
    const handleOauthFlowCancelled = () => {
      oauth.cancel();
      this.disconnectDigitalOceanAccount();
      this.showIntro();
    };
    this.appRoot.getAndShowDigitalOceanOauthFlow(handleOauthFlowCancelled);
    try {
      // DigitalOcean tokens expire after 30 days, unless they are manually
      // revoked by the user. After 30 days the user will have to sign into
      // DigitalOcean again. Note we cannot yet use DigitalOcean refresh
      // tokens, as they require a client_secret to be stored on a server and
      // not visible to end users in client-side JS. More details at:
      // https://developers.digitalocean.com/documentation/oauth/#refresh-token-flow
      return await oauth.result;
    } catch (error) {
      if (oauth.isCancelled()) {
        throw CANCELLED_ERROR;
      } else {
        throw error;
      }
    }
  }

  // Runs the GCP OAuth flow and returns the API refresh token (which can be
  // exchanged for an access token).
  // Throws CANCELLED_ERROR on cancellation, or the error in case of failure.
  private async runGcpOauthFlow(): Promise<string> {
    const oauth = runGcpOauth();
    const handleOauthFlowCancelled = () => {
      oauth.cancel();
      this.disconnectGcpAccount();
      this.showIntro();
    };
    this.appRoot.getAndShowGcpOauthFlow(handleOauthFlowCancelled);
    try {
      return await oauth.result;
    } catch (error) {
      if (oauth.isCancelled()) {
        throw CANCELLED_ERROR;
      } else {
        throw error;
      }
    }
  }

  private async handleConnectDigitalOceanAccountRequest(): Promise<void> {
    let digitalOceanAccount: digitalocean.Account = null;
    try {
      const accessToken = await this.runDigitalOceanOauthFlow();
      digitalOceanAccount = this.cloudAccounts.connectDigitalOceanAccount(accessToken);
    } catch (error) {
      this.disconnectDigitalOceanAccount();
      this.showIntro();
      bringToFront();
      if (error !== CANCELLED_ERROR) {
        console.error(`DigitalOcean authentication failed: ${error}`);
        this.appRoot.showError(this.appRoot.localize('error-do-auth'));
      }
      return;
    }

    const doServers = await this.loadDigitalOceanAccount(digitalOceanAccount);
    if (doServers.length > 0) {
      this.showServer(doServers[0]);
    } else {
      await this.showDigitalOceanCreateServer(this.digitalOceanAccount);
    }
  }

  private async handleConnectGcpAccountRequest(): Promise<void> {
    let gcpAccount: gcp.Account = null;
    try {
      const refreshToken = await this.runGcpOauthFlow();
      gcpAccount = this.cloudAccounts.connectGcpAccount(refreshToken);
    } catch (error) {
      this.disconnectGcpAccount();
      this.showIntro();
      bringToFront();
      if (error !== CANCELLED_ERROR) {
        console.error(`GCP authentication failed: ${error}`);
        this.appRoot.showError(this.appRoot.localize('error-gcp-auth'));
      }
      return;
    }

    await this.loadGcpAccount(gcpAccount);
    this.showIntro();
  }

  // Clears the DigitalOcean credentials and returns to the intro screen.
  private disconnectDigitalOceanAccount(): void {
    this.cloudAccounts.disconnectDigitalOceanAccount();
    this.digitalOceanAccount = null;
    for (const serverEntry of this.appRoot.serverList) {
      if (serverEntry.cloudProvider === 'DIGITALOCEAN') {
        this.removeServer(serverEntry.id);
      }
    }

    this.appRoot.accountList =
        this.appRoot.accountList.filter((account) => account.cloudProvider !== 'DIGITALOCEAN');
  }

  // Clears the GCP credentials and returns to the intro screen.
  private disconnectGcpAccount(): void {
    this.cloudAccounts.disconnectGcpAccount();
    this.gcpAccount = null;
    for (const serverEntry of this.appRoot.serverList) {
      if (serverEntry.cloudProvider === 'GCP') {
        this.removeServer(serverEntry.id);
      }
    }

    this.appRoot.accountList =
        this.appRoot.accountList.filter((account) => account.cloudProvider !== 'GCP');
  }

  // Opens the screen to create a server.
  private async showDigitalOceanCreateServer(digitalOceanAccount: digitalocean.Account):
      Promise<void> {
    try {
      await this.ensureActiveDigitalOceanAccount(digitalOceanAccount);
    } catch (error) {
      if (this.appRoot.currentPage === 'digitalOceanOauth') {
        this.showIntro();
      }
      if (error !== CANCELLED_ERROR) {
        console.error('Failed to validate DigitalOcean account', error);
        this.appRoot.showError(this.appRoot.localize('error-do-account-info'));
      }
      return;
    }

    // The region picker initially shows all options as disabled. Options are enabled by this code,
    // after checking which regions are available.
    try {
      const regionPicker = this.appRoot.getAndShowRegionPicker();
      const map = await this.digitalOceanRetry(() => {
        return this.digitalOceanAccount.getRegionMap();
      });
      const locations = Object.entries(map).map(([cityId, regionIds]) => {
        return this.createLocationModel(cityId, regionIds);
      });
      regionPicker.locations = locations;
    } catch (e) {
      console.error(`Failed to get list of available regions: ${e}`);
      this.appRoot.showError(this.appRoot.localize('error-do-regions'));
    }
  }

  // Returns a promise which fulfills once the DigitalOcean droplet is created.
  // Shadowbox may not be fully installed once this promise is fulfilled.
  public async createDigitalOceanServer(regionId: server.RegionId): Promise<void> {
    try {
      const serverName = this.makeLocalizedServerName(regionId);
      const server = await this.digitalOceanRetry(() => {
        return this.digitalOceanAccount.createServer(regionId, serverName);
      });
      this.addServer(server);
      this.showServer(server);
    } catch (error) {
      console.error('Error from createDigitalOceanServer', error);
      this.appRoot.showError(this.appRoot.localize('error-server-creation'));
    }
  }

  private getLocalizedCityName(regionId: server.RegionId): string {
    const cityId = digitalocean_server.GetCityId(regionId);
    return this.appRoot.localize(`city-${cityId}`);
  }

  private makeLocalizedServerName(regionId: server.RegionId): string {
    const serverLocation = this.getLocalizedCityName(regionId);
    return this.appRoot.localize('server-name', 'serverLocation', serverLocation);
  }

  public showServer(server: server.Server): void {
    this.selectedServer = server;
    this.appRoot.selectedServerId = server.getId();
    localStorage.setItem(LAST_DISPLAYED_SERVER_STORAGE_KEY, server.getId());
    this.appRoot.showServerView();
  }

  private async updateServerView(server: server.Server): Promise<void> {
    if (await server.isHealthy()) {
      this.setServerManagementView(server);
    } else {
      this.setServerUnreachableView(server);
    }
  }

  // Show the server management screen. Assumes the server is healthy.
  private setServerManagementView(server: server.Server): void {
    // Show view and initialize fields from selectedServer.
    const view = this.appRoot.getServerView(server.getId());
    const version = server.getVersion();
    view.selectedPage = 'managementView';
    view.serverId = server.getId();
    view.metricsId = server.getMetricsId();
    view.serverName = server.getName();
    view.serverHostname = server.getHostnameForAccessKeys();
    view.serverManagementApiUrl = server.getManagementApiUrl();
    view.serverPortForNewAccessKeys = server.getPortForNewAccessKeys();
    view.serverCreationDate = server.getCreatedDate();
    view.serverVersion = version;
    view.defaultDataLimitBytes = server.getDefaultDataLimit()?.bytes;
    view.isDefaultDataLimitEnabled = view.defaultDataLimitBytes !== undefined;
    view.showFeatureMetricsDisclaimer = server.getMetricsEnabled() &&
        !server.getDefaultDataLimit() && !hasSeenFeatureMetricsNotification();

    if (version) {
      view.isAccessKeyPortEditable = semver.gte(version, CHANGE_KEYS_PORT_VERSION);
      view.supportsDefaultDataLimit = semver.gte(version, DATA_LIMITS_VERSION);
      view.isHostnameEditable = semver.gte(version, CHANGE_HOSTNAME_VERSION);
      view.hasPerKeyDataLimitDialog = semver.gte(version, KEY_SETTINGS_VERSION);
    }

    if (isManagedServer(server)) {
      view.isServerManaged = true;
      const host = server.getHost();
      view.monthlyCost = host.getMonthlyCost().usd;
      view.monthlyOutboundTransferBytes =
          host.getMonthlyOutboundTransferLimit().terabytes * (10 ** 12);
      view.serverLocationId = digitalocean_server.GetCityId(host.getRegionId());
    } else {
      view.isServerManaged = false;
    }

    view.metricsEnabled = server.getMetricsEnabled();

    // Asynchronously load "My Connection" and other access keys in order to no block showing the
    // server.
    setTimeout(async () => {
      this.showMetricsOptInWhenNeeded(server, view);
      try {
        const serverAccessKeys = await server.listAccessKeys();
        view.accessKeyRows = serverAccessKeys.map(this.convertToUiAccessKey.bind(this));
        if (view.defaultDataLimitBytes === undefined) {
          view.defaultDataLimitBytes =
              (await computeDefaultDataLimit(server, serverAccessKeys))?.bytes;
        }
        // Show help bubbles once the page has rendered.
        setTimeout(() => {
          showHelpBubblesOnce(view);
        }, 250);
      } catch (error) {
        console.error(`Failed to load access keys: ${error}`);
        this.appRoot.showError(this.appRoot.localize('error-keys-get'));
      }
      this.showTransferStats(server, view);
    }, 0);
  }

  private setServerUnreachableView(server: server.Server): void {
    // Display the unreachable server state within the server view.
    const serverView = this.appRoot.getServerView(server.getId());
    serverView.selectedPage = 'unreachableView';
    serverView.isServerManaged = isManagedServer(server);
    serverView.serverName =
        this.makeDisplayName(server);  // Don't get the name from the remote server.
    serverView.retryDisplayingServer = async () => {
      await this.updateServerView(server);
    };
  }

  private setServerProgressView(server: server.Server): void {
    const view = this.appRoot.getServerView(server.getId());
    view.serverName = this.makeDisplayName(server);
    view.selectedPage = 'progressView';
  }

  private showMetricsOptInWhenNeeded(selectedServer: server.Server, serverView: ServerView) {
    const showMetricsOptInOnce = () => {
      // Sanity check to make sure the running server is still displayed, i.e.
      // it hasn't been deleted.
      if (this.selectedServer !== selectedServer) {
        return;
      }
      // Show the metrics opt in prompt if the server has not already opted in,
      // and if they haven't seen the prompt yet according to localStorage.
      const storageKey = selectedServer.getMetricsId() + '-prompted-for-metrics';
      if (!selectedServer.getMetricsEnabled() && !localStorage.getItem(storageKey)) {
        this.appRoot.showMetricsDialogForNewServer();
        localStorage.setItem(storageKey, 'true');
      }
    };

    // Calculate milliseconds passed since server creation.
    const createdDate = selectedServer.getCreatedDate();
    const now = new Date();
    const msSinceCreation = now.getTime() - createdDate.getTime();

    // Show metrics opt-in once ONE_DAY_IN_MS has passed since server creation.
    const ONE_DAY_IN_MS = 24 * 60 * 60 * 1000;
    if (msSinceCreation >= ONE_DAY_IN_MS) {
      showMetricsOptInOnce();
    } else {
      setTimeout(showMetricsOptInOnce, ONE_DAY_IN_MS - msSinceCreation);
    }
  }

  private async refreshTransferStats(selectedServer: server.Server, serverView: ServerView) {
    try {
      const usageMap = await selectedServer.getDataUsage();
      const keyTransfers = [...usageMap.values()];
      let totalInboundBytes = 0;
      for (const accessKeyBytes of keyTransfers) {
        totalInboundBytes += accessKeyBytes;
      }
      serverView.totalInboundBytes = totalInboundBytes;

      // Update all the displayed access keys, even if usage didn't change, in case data limits did.
      let keyTransferMax = 0;
      let dataLimitMax = selectedServer.getDefaultDataLimit()?.bytes ?? 0;
      for (const key of await selectedServer.listAccessKeys()) {
        serverView.updateAccessKeyRow(
            key.id,
            {transferredBytes: usageMap.get(key.id) ?? 0, dataLimitBytes: key.dataLimit?.bytes});
        keyTransferMax = Math.max(keyTransferMax, usageMap.get(key.id) ?? 0);
        dataLimitMax = Math.max(dataLimitMax, key.dataLimit?.bytes ?? 0);
      }
      serverView.baselineDataTransfer = Math.max(keyTransferMax, dataLimitMax);
    } catch (e) {
      // Since failures are invisible to users we generally want exceptions here to bubble
      // up and trigger a Sentry report. The exception is network errors, about which we can't
      // do much (note: ShadowboxServer generates a breadcrumb for failures regardless which
      // will show up when someone explicitly submits feedback).
      if (e instanceof errors.ServerApiError && e.isNetworkError()) {
        return;
      }
      throw e;
    }
  }

  private showTransferStats(selectedServer: server.Server, serverView: ServerView) {
    this.refreshTransferStats(selectedServer, serverView);
    // Get transfer stats once per minute for as long as server is selected.
    const statsRefreshRateMs = 60 * 1000;
    const intervalId = setInterval(() => {
      if (this.selectedServer !== selectedServer) {
        // Server is no longer running, stop interval
        clearInterval(intervalId);
        return;
      }
      this.refreshTransferStats(selectedServer, serverView);
    }, statsRefreshRateMs);
  }

  private getS3InviteUrl(accessUrl: string, isAdmin = false) {
    // TODO(alalama): display the invite in the user's preferred language.
    const adminParam = isAdmin ? '?admin_embed' : '';
    return `https://s3.amazonaws.com/outline-vpn/invite.html${adminParam}#${
        encodeURIComponent(accessUrl)}`;
  }

  // Converts the access key model to the format used by outline-server-view.
  private convertToUiAccessKey(remoteAccessKey: server.AccessKey): DisplayAccessKey {
    return {
      id: remoteAccessKey.id,
      placeholderName: this.appRoot.localize('key', 'keyId', remoteAccessKey.id),
      name: remoteAccessKey.name,
      accessUrl: remoteAccessKey.accessUrl,
      transferredBytes: 0,
      dataLimitBytes: remoteAccessKey.dataLimit?.bytes,
    };
  }

  private addAccessKey() {
    this.selectedServer.addAccessKey()
        .then((serverAccessKey: server.AccessKey) => {
          const uiAccessKey = this.convertToUiAccessKey(serverAccessKey);
          this.appRoot.getServerView(this.appRoot.selectedServerId).addAccessKey(uiAccessKey);
          this.appRoot.showNotification(this.appRoot.localize('notification-key-added'));
        })
        .catch((error) => {
          console.error(`Failed to add access key: ${error}`);
          this.appRoot.showError(this.appRoot.localize('error-key-add'));
        });
  }

  private renameAccessKey(accessKeyId: string, newName: string, entry: polymer.Base) {
    this.selectedServer.renameAccessKey(accessKeyId, newName)
        .then(() => {
          entry.commitName();
        })
        .catch((error) => {
          console.error(`Failed to rename access key: ${error}`);
          this.appRoot.showError(this.appRoot.localize('error-key-rename'));
          entry.revertName();
        });
  }

  private async setDefaultDataLimit(limit: server.DataLimit) {
    if (!limit) {
      return;
    }
    const previousLimit = this.selectedServer.getDefaultDataLimit();
    if (previousLimit && limit.bytes === previousLimit.bytes) {
      return;
    }
    const serverView = this.appRoot.getServerView(this.appRoot.selectedServerId);
    try {
      await this.selectedServer.setDefaultDataLimit(limit);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      serverView.defaultDataLimitBytes = limit?.bytes;
      serverView.isDefaultDataLimitEnabled = true;
      this.refreshTransferStats(this.selectedServer, serverView);
      // Don't display the feature collection disclaimer anymore.
      serverView.showFeatureMetricsDisclaimer = false;
      window.localStorage.setItem('dataLimits-feature-collection-notification', 'true');
    } catch (error) {
      console.error(`Failed to set server default data limit: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-set-data-limit'));
      const defaultLimit = previousLimit || await computeDefaultDataLimit(this.selectedServer);
      serverView.defaultDataLimitBytes = defaultLimit?.bytes;
      serverView.isDefaultDataLimitEnabled = !!previousLimit;
    }
  }

  private async removeDefaultDataLimit() {
    const serverView = this.appRoot.getServerView(this.appRoot.selectedServerId);
    const previousLimit = this.selectedServer.getDefaultDataLimit();
    try {
      await this.selectedServer.removeDefaultDataLimit();
      serverView.isDefaultDataLimitEnabled = false;
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      this.refreshTransferStats(this.selectedServer, serverView);
    } catch (error) {
      console.error(`Failed to remove server default data limit: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-remove-data-limit'));
      serverView.isDefaultDataLimitEnabled = !!previousLimit;
    }
  }

  private openPerKeyDataLimitDialog(event: CustomEvent<{
    keyId: string,
    keyDataLimitBytes: number|undefined,
    keyName: string,
    serverId: string,
    defaultDataLimitBytes: number|undefined
  }>) {
    const detail = event.detail;
    const onDataLimitSet = this.savePerKeyDataLimit.bind(this, detail.serverId, detail.keyId);
    const onDataLimitRemoved = this.removePerKeyDataLimit.bind(this, detail.serverId, detail.keyId);
    const activeDataLimitBytes = detail.keyDataLimitBytes ?? detail.defaultDataLimitBytes;
    this.appRoot.openPerKeyDataLimitDialog(
        detail.keyName, activeDataLimitBytes, onDataLimitSet, onDataLimitRemoved);
  }

  private async savePerKeyDataLimit(serverId: string, keyId: string, dataLimitBytes: number):
      Promise<boolean> {
    this.appRoot.showNotification(this.appRoot.localize('saving'));
    const server = this.idServerMap.get(serverId);
    const serverView = this.appRoot.getServerView(server.getId());
    try {
      await server.setAccessKeyDataLimit(keyId, {bytes: dataLimitBytes});
      this.refreshTransferStats(server, serverView);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      return true;
    } catch (error) {
      console.error(`Failed to set data limit for access key ${keyId}: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-set-per-key-limit'));
      return false;
    }
  }

  private async removePerKeyDataLimit(serverId: string, keyId: string): Promise<boolean> {
    this.appRoot.showNotification(this.appRoot.localize('saving'));
    const server = this.idServerMap.get(serverId);
    const serverView = this.appRoot.getServerView(server.getId());
    try {
      await server.removeAccessKeyDataLimit(keyId);
      this.refreshTransferStats(server, serverView);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      return true;
    } catch (error) {
      console.error(`Failed to remove data limit from access key ${keyId}: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-remove-per-key-limit'));
      return false;
    }
  }

  private async setHostnameForAccessKeys(hostname: string, serverSettings: polymer.Base) {
    this.appRoot.showNotification(this.appRoot.localize('saving'));
    try {
      await this.selectedServer.setHostnameForAccessKeys(hostname);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      serverSettings.enterSavedState();
    } catch (error) {
      this.appRoot.showError(this.appRoot.localize('error-not-saved'));
      if (error.isNetworkError()) {
        serverSettings.enterErrorState(this.appRoot.localize('error-network'));
        return;
      }
      const message = error.response.status === 400 ? 'error-hostname-invalid' : 'error-unexpected';
      serverSettings.enterErrorState(this.appRoot.localize(message));
    }
  }

  private async setPortForNewAccessKeys(port: number, serverSettings: polymer.Base) {
    this.appRoot.showNotification(this.appRoot.localize('saving'));
    try {
      await this.selectedServer.setPortForNewAccessKeys(port);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      serverSettings.enterSavedState();
    } catch (error) {
      this.appRoot.showError(this.appRoot.localize('error-not-saved'));
      if (error.isNetworkError()) {
        serverSettings.enterErrorState(this.appRoot.localize('error-network'));
        return;
      }
      const code = error.response.status;
      if (code === 409) {
        serverSettings.enterErrorState(this.appRoot.localize('error-keys-port-in-use'));
        return;
      }
      serverSettings.enterErrorState(this.appRoot.localize('error-unexpected'));
    }
  }

  // Returns promise which fulfills when the server is created successfully,
  // or rejects with an error message that can be displayed to the user.
  public async createManualServer(userInput: string): Promise<void> {
    let serverConfig: server.ManualServerConfig;
    try {
      serverConfig = parseManualServerConfig(userInput);
    } catch (e) {
      // This shouldn't happen because the UI validates the URL before enabling the DONE button.
      const msg = `could not parse server config: ${e.message}`;
      console.error(msg);
      throw new Error(msg);
    }

    // Don't let `ManualServerRepository.addServer` throw to avoid redundant error handling if we
    // are adding an existing server. Query the repository instead to treat the UI accordingly.
    const storedServer = this.manualServerRepository.findServer(serverConfig);
    if (!!storedServer) {
      this.appRoot.showNotification(this.appRoot.localize('notification-server-exists'), 5000);
      this.showServer(storedServer);
      return;
    }
    const manualServer = await this.manualServerRepository.addServer(serverConfig);
    if (await manualServer.isHealthy()) {
      this.addServer(manualServer);
      this.showServer(manualServer);
    } else {
      // Remove inaccessible manual server from local storage if it was just created.
      manualServer.forget();
      console.error('Manual server installed but unreachable.');
      throw new errors.UnreachableServerError();
    }
  }

  private removeAccessKey(accessKeyId: string) {
    this.selectedServer.removeAccessKey(accessKeyId)
        .then(() => {
          this.appRoot.getServerView(this.appRoot.selectedServerId).removeAccessKey(accessKeyId);
          this.appRoot.showNotification(this.appRoot.localize('notification-key-removed'));
        })
        .catch((error) => {
          console.error(`Failed to remove access key: ${error}`);
          this.appRoot.showError(this.appRoot.localize('error-key-remove'));
        });
  }

  private deleteSelectedServer() {
    const serverToDelete = this.selectedServer;
    const serverId = serverToDelete.getId();
    if (!isManagedServer(serverToDelete)) {
      const msg = 'cannot delete non-ManagedServer';
      console.error(msg);
      throw new Error(msg);
    }

    const confirmationTitle = this.appRoot.localize('confirmation-server-destroy-title');
    const confirmationText = this.appRoot.localize('confirmation-server-destroy');
    const confirmationButton = this.appRoot.localize('destroy');
    this.appRoot.getConfirmation(confirmationTitle, confirmationText, confirmationButton, () => {
      this.digitalOceanRetry(() => {
            return serverToDelete.getHost().delete();
          })
          .then(
              () => {
                this.removeServer(serverId);
                this.appRoot.selectedServer = null;
                this.selectedServer = null;
                this.showIntro();
                this.appRoot.showNotification(
                    this.appRoot.localize('notification-server-destroyed'));
              },
              (e) => {
                // Don't show a toast on the login screen.
                if (!(e instanceof digitalocean_api.XhrError)) {
                  console.error(`Failed destroy server: ${e}`);
                  this.appRoot.showError(this.appRoot.localize('error-server-destroy'));
                }
              });
    });
  }

  private forgetSelectedServer() {
    const serverToForget = this.selectedServer;
    const serverId = serverToForget.getId();
    if (!isManualServer(serverToForget)) {
      const msg = 'cannot forget non-ManualServer';
      console.error(msg);
      throw new Error(msg);
    }

    const confirmationTitle = this.appRoot.localize('confirmation-server-remove-title');
    const confirmationText = this.appRoot.localize('confirmation-server-remove');
    const confirmationButton = this.appRoot.localize('remove');
    this.appRoot.getConfirmation(confirmationTitle, confirmationText, confirmationButton, () => {
      serverToForget.forget();
      this.removeServer(serverId);
      this.appRoot.selectedServerId = '';
      this.selectedServer = null;
      this.showIntro();
      this.appRoot.showNotification(this.appRoot.localize('notification-server-removed'));
    });
  }

  private async setMetricsEnabled(metricsEnabled: boolean) {
    const serverView = this.appRoot.getServerView(this.appRoot.selectedServerId);
    try {
      await this.selectedServer.setMetricsEnabled(metricsEnabled);
      this.appRoot.showNotification(this.appRoot.localize('saved'));
      // Change metricsEnabled property on polymer element to update display.
      serverView.metricsEnabled = metricsEnabled;
    } catch (error) {
      console.error(`Failed to set metrics enabled: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-metrics'));
      serverView.metricsEnabled = !metricsEnabled;
    }
  }

  private async renameServer(newName: string) {
    const serverToRename = this.selectedServer;
    const serverId = this.appRoot.selectedServerId;
    const view = this.appRoot.getServerView(serverId);
    try {
      await serverToRename.setName(newName);
      view.serverName = newName;
      this.updateServerEntry(serverToRename);
    } catch (error) {
      console.error(`Failed to rename server: ${error}`);
      this.appRoot.showError(this.appRoot.localize('error-server-rename'));
      const oldName = this.selectedServer.getName();
      view.serverName = oldName;
      // tslint:disable-next-line:no-any
      (view.$.serverSettings as any).serverName = oldName;
    }
  }

  private cancelServerCreation(serverToCancel: server.Server): void {
    if (!isManagedServer(serverToCancel)) {
      const msg = 'cannot cancel non-ManagedServer';
      console.error(msg);
      throw new Error(msg);
    }
    serverToCancel.getHost().delete().then(() => {
      this.removeServer(serverToCancel.getId());
      this.showIntro();
    });
  }

  private async setAppLanguage(languageCode: string, languageDir: string) {
    try {
      await this.appRoot.setLanguage(languageCode, languageDir);
      document.documentElement.setAttribute('dir', languageDir);
      window.localStorage.setItem('overrideLanguage', languageCode);
    } catch (error) {
      this.appRoot.showError(this.appRoot.localize('error-unexpected'));
    }
  }

  private createLocationModel(cityId: string, regionIds: string[]): Location {
    return {
      id: regionIds.length > 0 ? regionIds[0] : null,
      name: this.appRoot.localize(`city-${cityId}`),
      flag: DIGITALOCEAN_FLAG_MAPPING[cityId] || '',
      available: regionIds.length > 0,
    };
  }
}
