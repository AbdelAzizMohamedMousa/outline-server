// Copyright 2018 The Outline Authors

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at

//      http://www.apache.org/licenses/LICENSE-2.0

// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as errors from '../infrastructure/custom_error';

export interface DigitalOceanDropletSpecification {
  installCommand: string;
  size: string;
  image: string;
  tags: string[];
}

// See definition and example at
// https://developers.digitalocean.com/documentation/v2/#retrieve-an-existing-droplet-by-id
export type DropletInfo = Readonly<{
  id: number;
  status: 'new' | 'active';
  tags: string[];
  region: {readonly slug: string};
  size: Readonly<{
    transfer: number;
    price_monthly: number;
  }>;
  networks: Readonly<{
    v4: ReadonlyArray<
      Readonly<{
        type: string;
        ip_address: string;
      }>>
    >;
  }>;
}>;

// Reference:
// https://developers.digitalocean.com/documentation/v2/#get-user-information
export type Account = Readonly<{
  droplet_limit: number;
  email: string;
  uuid: string;
  email_verified: boolean;
  status: 'active' | 'warning' | 'locked';
  status_message: string;
}>;

// Reference:
// https://developers.digitalocean.com/documentation/v2/#regions
export type RegionInfo = Readonly<{
  slug: string;
  name: string;
  sizes: string[];
  available: boolean;
  features: string[];
}>;

// Marker class for errors due to network or authentication.
// See below for more details on when this is raised.
export class XhrError extends errors.CustomError {
  constructor() {
    // No message because XMLHttpRequest.onerror provides no useful info.
    super();
  }
}

// This class contains methods to interact with DigitalOcean on behalf of a user.
export interface DigitalOceanSession {
  accessToken: string;
  getAccount(): Promise
