/**
 * @license
 * Copyright 2024 Google LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * @fileoverview Test helpers for the common library.
 */

// g3-format-prettier

import {AdsClientArgs} from 'common/ads_api_types';
import {FakePropertyStore} from 'common/test_helpers/mock_apps_script';
import {
  CredentialManager,
  GoogleAdsApiFactory,
  ReportFactory,
} from '../ads_api';
import {AbstractRuleRange, AppsScriptFrontEnd} from '../sheet_helpers';
import {
  AppsScriptFunctions,
  BaseClientArgs,
  BaseClientInterface,
  ExecutorResult,
  FrontEndArgs,
  ParamDefinition,
  RecordInfo,
  RuleExecutor,
  RuleExecutorClass,
  RuleGetter,
} from '../types';

/**
 * Test granularity for use in tests.
 */
export enum Granularity {
  DEFAULT = 'default',
}

/**
 * Test client interface for use in tests.
 */
export interface TestClientInterface
  extends BaseClientInterface<
    TestClientInterface,
    Granularity,
    BaseClientArgs
  > {
  id: string;
  getAllCampaigns(): Promise<RecordInfo[]>;
}

/**
 * Test ad client interface for use in tests.
 */
export interface AdsClientInterface
  extends BaseClientInterface<AdsClientInterface, Granularity, AdsClientArgs> {
  id: string;
  getAllCampaigns(): Promise<RecordInfo[]>;
}

/**
 * Stub for rule range
 */
export class RuleRange extends AbstractRuleRange<
  TestClientInterface,
  Granularity,
  BaseClientArgs
> {
  async getRows() {
    return [{id: '1', displayName: 'Campaign 1', advertiserId: '1'}];
  }
}

/**
 * Test client for use in tests.
 */
export class FakeClient implements TestClientInterface {
  readonly args: BaseClientArgs = {label: 'test'};
  readonly ruleStore: {
    [ruleName: string]: RuleExecutor<
      TestClientInterface,
      Granularity,
      BaseClientArgs,
      Record<string, ParamDefinition>
    >;
  } = {};
  readonly properties = new FakePropertyStore();

  getRule(
    ruleName: string,
  ): RuleExecutor<
    TestClientInterface,
    Granularity,
    BaseClientArgs,
    Record<string, ParamDefinition>
  > {
    throw new Error('Method not implemented.');
  }
  getUniqueKey(prefix: string): string {
    throw new Error('Method not implemented.');
  }
  validate(): Promise<{
    rules: Record<
      string,
      RuleExecutor<
        TestClientInterface,
        Granularity,
        BaseClientArgs,
        Record<string, ParamDefinition>
      >
    >;
    results: Record<string, ExecutorResult>;
  }> {
    throw new Error('Method not implemented.');
  }
  addRule<Params extends Record<keyof Params, ParamDefinition>>(
    rule: RuleExecutorClass<
      TestClientInterface,
      Granularity,
      BaseClientArgs,
      Params
    >,
    settingsArray: ReadonlyArray<string[]>,
  ): TestClientInterface {
    throw new Error('Method not implemented.');
  }
  id = 'something';

  getAllCampaigns(): Promise<[]> {
    return Promise.resolve([]);
  }
}

/**
 * A fake frontend for testing.
 */
export class FakeFrontEnd extends AppsScriptFrontEnd<
  TestClientInterface,
  Granularity,
  BaseClientArgs,
  FakeFrontEnd
> {
  readonly calls: Record<AppsScriptFunctions, number> = {
    onOpen: 0,
    initializeSheets: 0,
    launchMonitor: 0,
    preLaunchQa: 0,
    displaySetupGuide: 0,
    displayGlossary: 0,
  };
  private readonly messages: GoogleAppsScript.Mail.MailAdvancedParameters[] =
    [];

  constructor(
    args: FrontEndArgs<
      TestClientInterface,
      Granularity,
      BaseClientArgs,
      FakeFrontEnd
    >,
  ) {
    scaffoldSheetWithNamedRanges();
    super('Fake', args);
  }

  getIdentity(): BaseClientArgs {
    return {label: 'test'};
  }

  override async onOpen() {
    this.calls.onOpen++;
  }

  override async initializeSheets() {
    this.calls.initializeSheets++;
    await super.initializeSheets();
  }

  override async preLaunchQa() {
    this.calls.preLaunchQa++;
  }

  override async launchMonitor() {
    this.calls.launchMonitor++;
  }

  override async sendEmailAlert(
    rules: RuleGetter[],
    message: GoogleAppsScript.Mail.MailAdvancedParameters,
  ) {
    const noop: GoogleAppsScript.Mail.MailApp['sendEmail'] = ((
      message: GoogleAppsScript.Mail.MailAdvancedParameters,
    ) => {}) as GoogleAppsScript.Mail.MailApp['sendEmail'];
    super.sendEmailAlert(rules, message, noop);

    this.messages.push(message);
  }

  getMessages() {
    return this.messages.splice(0, this.messages.length);
  }
}

/**
 * Set up named ranges so basic things can work in frontend.
 */
export function scaffoldSheetWithNamedRanges() {
  for (const [i, [constName, value]] of [
    ['ENTITY_ID', '1'],
    ['ID_TYPE', 'Advertiser'],
    ['EMAIL_LIST', ''],
    ['LABEL', 'Acme Inc.'],
  ].entries()) {
    const range = SpreadsheetApp.getActive()
      .getActiveSheet()
      .getRange(`$A$${i + 1}`);
    SpreadsheetApp.getActive().setNamedRange(constName, range);
    SpreadsheetApp.getActive().getRangeByName(constName)!.setValue(value);
  }
}

const FAKE_API_ENDPOINT = {
  url: 'my://url',
  version: 'v0',
  call: 'fake:call',
};

/**
 * Set up a Google Ads API for testing.
 */
export function bootstrapGoogleAdsApi() {
  const apiFactory = new GoogleAdsApiFactory({
    developerToken: '',
    credentialManager: new CredentialManager(),
    apiEndpoint: FAKE_API_ENDPOINT,
  });
  const reportFactory = new ReportFactory(apiFactory, {
    customerIds: '1',
    label: 'test',
  });
  const api = apiFactory.create('');
  spyOn(apiFactory, 'create').and.returnValue(api);
  return {api, reportFactory};
}
/**
 * Like TestClientInterface only for Ads.
 */
export interface AdsClientInterface
  extends BaseClientInterface<AdsClientInterface, Granularity, AdsClientArgs> {}
