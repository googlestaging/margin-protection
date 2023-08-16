/**
 * @license
 * Copyright 2023 Google LLC.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {AppsScriptPropertyStore, getRule, PropertyStore, Value, Values} from 'anomaly_library/main';

import {AppsScriptFunctions, BaseClientArgs, BaseClientInterface, ExecutorResult, FrontEndArgs, ParamDefinition, RecordInfo, RuleDefinition, RuleExecutor, RuleExecutorClass, RuleGranularity, RuleParams, RuleRangeInterface, RuleUtilities, SettingMapInterface, Settings} from './types';

const FOLDER = 'application/vnd.google-apps.folder';
const HEADER_RULE_NAME_INDEX = 0;
/**
 * The number of headers at the top of a rule sheet.
 */
const SHEET_TOP_PADDING = 2;

type ScriptFunction<F> = (properties: PropertyStore) => F;
type ScriptEntryPoints = 'onOpen'|'initializeSheets'|'preLaunchQa'|
    'launchMonitor'|'displaySetupGuide'|'displayGlossary';

/**
 * The name of the rule settings sheet (before granularity).
 */
export const RULE_SETTINGS_SHEET = 'Rule Settings';

/**
 * The name of the general settings sheet.
 */
export const GENERAL_SETTINGS_SHEET = 'General/Settings';

/**
 * Provides a useful data structure to get campaign ID settings.
 *
 * Defaults to the row with campaignId: 'default' if no campaign ID override is
 * set.
 */
export class SettingMap<P extends {[Property in keyof P]: P[keyof P]}>
    implements SettingMapInterface<P> {
  private readonly map: Map<string, P>;
  private readonly keys: Array<keyof P>;

  constructor(values: Array<[string, P]>) {
    this.map = new Map(values);
    this.keys = Object.keys(values[0][1]) as Array<keyof P>;
  }

  get(id: string): P {
    const obj = this.map.get(id);
    if (obj) {
      return obj;
    }
    const newObj = Object.fromEntries(this.keys.map(k => [k, ''])) as P;
    this.map.set(id, newObj);
    return newObj;
  }

  getOrDefault(id: string): P {
    const defaultValue =
        this.map.get('default') || {} as Record<keyof P, string>;
    const campaignValue = this.map.get(id) || {} as Record<keyof P, string>;
    return this.keys.reduce((prev, key) => {
      prev[key] = (!(key in campaignValue) || campaignValue[key] === '' ?
                       defaultValue[key] :
                       campaignValue[key]) ??
          '';
      return prev;
    }, {} as Record<keyof P, string>) as P;
  }

  entries(): ReadonlyArray<[string, string[]]> {
    const arr: Array<[string, string[]]> = [];
    for (const [id, row] of this.map.entries()) {
      arr.push([id, Object.values(row)]);
    }
    return arr;
  }

  set(id: string, setting: P) {
    this.map.set(id, setting);
  }
}

/**
 * Converts a settings 2-d array to an internal data structure.
 *
 * The 2-d array has headers as parameters and rows as campaign IDs.
 *
 * Example in CSV form:
 *
 *    campaignID, campaignName, My Param 1, My Param 2
 *    default,,hello,world
 *    1, acme campaign, foo, bar
 *
 * Note  two columns in the front which include the campaign ID and campaign
 * name.
 *
 * There's also allowance for a single "default" column without a campaign name.
 *
 * @param rawSettings A 2-d array (usually auto-generated by this app)
 * @param mapper Maps internal params to the user-facing definition
 *     e.g. {param1: {title: 'My Param 1'}}
 */
export function
transformToParamValues<MapType extends Record<keyof MapType, ParamDefinition>>(
    rawSettings: readonly string[][], mapper: MapType) {
  if (rawSettings.length < 2) {
    throw new Error(
        'Expected a grid with row and column headers of at least size 2');
  }
  const headers = rawSettings[0];
  const body = rawSettings.slice(1);

  function forEachRow(row: readonly string[]):
      [string, {[Property in keyof MapType]: string}] {
    return [
      row[0],
      Object.fromEntries(
          Object.entries<ParamDefinition>(mapper).map(([param, {label}]) => {
            const i = headers.indexOf(label);
            return [param, row[i]];
          })) as {[Property in keyof MapType]: string},
    ];
  }
  return new SettingMap(body.map(forEachRow));
}

function makeCampaignIndexedSettings(
    headers: string[],
    currentSettings: string[][]): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (let i = 0; i < currentSettings.length; i++) {
    const campaignId = currentSettings[i][0];
    for (let c = 1; c < currentSettings[i].length; c++) {
      (result[campaignId] = result[campaignId] ?? {})[headers[c - 1]] =
          currentSettings[i][c];
    }
  }
  return result;
}

/**
 * Rule split according to the name of the rule in a dictionary.
 *
 * The range has two headers: Header 1 is category/rule names, and
 * header 2 is the name of the rule setting to be changed.
 */
export abstract class AbstractRuleRange<
    C extends BaseClientInterface<C, G, A>,
              G extends RuleGranularity<G>, A extends BaseClientArgs<C, G, A>>
    implements RuleRangeInterface<C, G, A> {
  private rowIndex: Record<string, number> = {};
  private readonly columnOrders: Record<string, Record<string, number>> = {};
  private readonly rules: Record<string, string[][]>&
      Record<'none', string[][]> = {'none': [[]]};
  private length: number = 0;

  constructor(
      range: string[][], protected readonly client: C,
      constantHeaders: string[] = ['ID', 'default']) {
    for (let i = 0; i < constantHeaders.length; i++) {
      this.rowIndex[constantHeaders[i]] = i;
    }
    this.length = Object.keys(this.rowIndex).length;
    this.setRules(range);
  }

  setRow(category: string, id: string, column: string[]): void {
    if (id === '') {
      return;
    }
    if (this.rowIndex[id] === undefined) {
      this.rowIndex[id] = ++this.length
    }
    (this.rules[category] = this.rules[category] || [])[this.rowIndex[id]] =
        column;
  }

  getValues(ruleGranularity?: G): string[][] {
    const newRowIndex = {...this.rowIndex};
    const defaultFirstColumns = ['', ''];

    const values =
        Object.entries(this.rules).reduce((combinedRuleRange, [category, rangeRaw]) => {
          const range = rangeRaw.filter(row => row && row.length);
          if (ruleGranularity &&
              (category !== 'none' &&
               this.client.ruleStore[category].granularity !==
                   ruleGranularity)) {
            return combinedRuleRange;
          }
          const ruleSettingColumnCount = range.length ? range[HEADER_RULE_NAME_INDEX].length : 0;
          if (!ruleSettingColumnCount) {
            return combinedRuleRange;
          }
          const ruleSettingColumnOffset = combinedRuleRange[0].length;
          combinedRuleRange[0] = combinedRuleRange[0].concat(
              Array.from({length: ruleSettingColumnCount}).fill(category === 'none' ? '' : category) as
              string[]);

          combinedRuleRange[1] = category === 'none' ?
              defaultFirstColumns :
              combinedRuleRange[1].concat(
                  Array.from<string>({length: ruleSettingColumnCount}).fill('').map((cell, idx) => {
                    if (idx === 0 && this.client.ruleStore[combinedRuleRange[0][idx + ruleSettingColumnOffset]]) {
                      return this.client.ruleStore[combinedRuleRange[0][idx + ruleSettingColumnOffset]].helper;
                    } else {
                      return '';
                    }
                  }));
          // Using the default row order can lead to some weird things like the
          // header coming in at the end of the list if {'a': 2, 'b': 1}.
          // Below `rowIndex` is sorted and reorganized. The resulting range
          // will reflect the correct `rowIndex` so that order is never
          // incorrect.
          type IndexEntry = [entityId: string, currentPosition: number];
          const indexEntries: IndexEntry[] = Object.entries<number>(this.rowIndex);
          const sortedEntries = indexEntries.sort((firstVal: IndexEntry, secondVal: IndexEntry) => firstVal[1] - secondVal[1]);
          sortedEntries
              .forEach(([entityId, currentOrdinalValue], postSortedOrdinalValue) => {
                const offsetRow = postSortedOrdinalValue + SHEET_TOP_PADDING;
                combinedRuleRange[offsetRow] =
                    (combinedRuleRange[offsetRow] = combinedRuleRange[offsetRow] || [])
                        .concat((
                            rangeRaw[currentOrdinalValue] ?? Array.from<string>({length: ruleSettingColumnCount}).fill('')));
                newRowIndex[entityId] = offsetRow;
              });
          return combinedRuleRange;
        }, [[], []] as string[][]);

    for (let c = values[0].length - 1; c > 0; c--) {
      values[0][c] = values[0][c - 1] === values[0][c] ? '' : values[0][c];
    }

    this.rowIndex = newRowIndex;
    return values;
  }

  getRule(ruleName: string): string[][] {
    if (!this.rules[ruleName] || !this.rules[ruleName].length) {
      return [];
    }
    return Object.values(this.rowIndex)
        .filter(
            (index) => this.rules['none'][index] !== undefined && this.rules[ruleName][index] !== undefined)
        .sort((a, b) => a - b)
        .map((index) => {
          return [this.rules['none'][index][0], ...this.rules[ruleName][index]];
        });
  }

  /**
   * Available for testing.
   */
  setRule(ruleName: string, ruleValues: string[][]) {
    for (let r = 0; r < ruleValues.length; r++) {
      this.setRow(ruleName, ruleValues[r][0], ruleValues[r].slice(1));
    }
  }

  setRules(range: string[][]) {
    let start = 0;
    let col = 0;
    const thresholds: Array<[number, number]> = [];
    for (col = 0; col < range[0].length; col++) {
      if (range[0][col]) {
        thresholds.push([start, col]);
        start = col;
      }
    }
    if (start !== col) {
      thresholds.push([start, col]);
    }
    for (let r = 0; r < range.length; r++) {
      for (const [start, end] of thresholds) {
        this.setRow(
            range[0][start] || 'none', range[r][0],
            range[r].slice(start, end));
      }
    }
  }

  async fillRuleValues<Params>(
      rule: Pick<
          RuleDefinition<Record<keyof Params, ParamDefinition>, G>,
          'name'|'params'|'defaults'|'granularity'>) {
    if (!rule.defaults) {
      throw new Error('Missing default values definition in fillRow');
    }

    const headersByIndex: {[index: number]: string} = {};
    const paramsByHeader: {[index: string]: keyof Params} = {};
    const indexByHeader: {[header: string]: number} = {};
    Object.entries<ParamDefinition>(rule.params)
        .forEach(([key, {label}], index) => {
          headersByIndex[index] = label;
          paramsByHeader[label] = key as keyof Params;
          indexByHeader[label] = index;
        });
    this.columnOrders[rule.name] =
        this.columnOrders[rule.name] || indexByHeader;
    const ruleValues = this.getRule(rule.name);
    const currentSettings = makeCampaignIndexedSettings(
        ruleValues[0] ? ruleValues[0].slice(1) : [], ruleValues);
    const length = Object.keys(rule.params).length;

    this.setRow('none', 'ID', ['ID', `${rule.granularity} Name`]);
    this.setRow(rule.name, 'ID', [...Object.values(headersByIndex)]);
    this.setRow('none', 'default', ['default', '']);
    this.setRow(
        rule.name, 'default',
        Array.from({length}).map(
            (unused, index) => currentSettings && currentSettings['default'] ?
                currentSettings['default'][headersByIndex[index]] ??
                    rule.defaults[paramsByHeader[headersByIndex[index]]] :
                rule.defaults[paramsByHeader[headersByIndex[index]]]));
    const inSystem = new Set<string>(['ID', 'default']);
    for (const record of await this.getRows(rule.granularity)) {
      this.setRow(
          rule.name, record.id,
          Array.from({length}).map(
              (unused, index) => currentSettings && currentSettings[record.id] ?
                  currentSettings[record.id][headersByIndex[index]] ?? '' :
                  ''));
      this.setRow('none', record.id, [record.id, record.displayName]);
      inSystem.add(record.id);
    }
    for (const row of Object.keys(this.rowIndex)) {
      if (!inSystem.has(row)) {
        delete this.rowIndex[row];
      }
    }
  }

  writeBack(ruleGranularity: G) {
    const values = this.getValues(ruleGranularity);
    const range = getOrCreateSheet(`Rule Settings - ${ruleGranularity}`).getRange(1, 1, values.length, values[0].length);
    range.setValues(values);
    console.log('done');
  }

  abstract getRows(granularity: G): Promise<RecordInfo[]>;

}

/**
 * Convenience method to optionally create, then retrieve a sheet by name.
 */
export function getOrCreateSheet(sheetName: string) {
  const active = SpreadsheetApp.getActive();
  return active.getSheetByName(sheetName) || active.insertSheet(sheetName);
}

const SCRIPT_PULL = 'scriptPull';

/**
 * Helpers that can be stubbed in tests for migrations.
 */
export const HELPERS = {
  insertRows(range: GoogleAppsScript.Spreadsheet.Range) {
    range.insertCells(SpreadsheetApp.Dimension.ROWS);
  },
  saveLastReportPull(time: number) {
    CacheService.getScriptCache().put(SCRIPT_PULL, time.toString());
  },
  getLastReportPull(): number {
    return Number(CacheService.getScriptCache().get(SCRIPT_PULL));
  },
  getSheetId() {
    return SpreadsheetApp.getActive().getId();
  }
};

/**
 * Retrieves a named range, if it exists. Otherwise, it throws an error.
 */
export function getTemplateSetting(rangeName: string):
    GoogleAppsScript.Spreadsheet.Range {
  const range = SpreadsheetApp.getActive().getRangeByName(rangeName);
  if (!range) {
    throw new Error(`The sheet has an error. A named range '${
        rangeName}' that should exist does not.`);
  }

  return range;
}

/**
 * The front-end for Apps Script UIs. This is extensible for customer use-cases.
 *
 * While the default application should cover base needs, customers may want to
 * program custom rules or use Firebase for increased storage space.
 */
export abstract class AppsScriptFrontEnd<
    C extends BaseClientInterface<C, G, A>, G extends RuleGranularity<G>,
                                                      A extends
        BaseClientArgs<C, G, A>, F extends AppsScriptFrontEnd<C, G, A, F>> {
  readonly client: C;
  readonly rules: ReadonlyArray<RuleExecutorClass<C, G, A>>;

  protected constructor(
      private readonly category: string,
      private readonly injectedArgs: FrontEndArgs<C, G, A, F>,
  ) {
    const clientArgs = this.getIdentity();
    if (!clientArgs) {
      throw new Error('Cannot initialize front-end without client ID(s)');
    }
    this.client =
        new injectedArgs.clientClass(clientArgs, injectedArgs.properties);
    this.rules = injectedArgs.rules;
  }

  /**
   * The primary interface.
   *
   * Schedule this function using `client.launchMonitor()` at your preferred
   * cadence.
   */
  async onOpen() {
    SpreadsheetApp.getUi()
        .createMenu('Launch Monitor')
        .addItem('Sync Campaigns', 'initializeSheets')
        .addItem('Pre-Launch QA', 'preLaunchQa')
        .addSeparator()
        .addSubMenu(SpreadsheetApp.getUi()
                        .createMenu('Guides')
                        .addItem('Show Setup Guide', 'displaySetupGuide')
                        .addItem('Show Glossary', 'displayGlossary'))
        .addToUi();
  }

  /**
   * Creates the sheets for the spreadsheet if they don't exist already.
   *
   * If they do exist, merges data from the existing and adds any new rules
   * that aren't already there.
   */
  async initializeRules() {
    const numberOfHeaders = 3;
    const sheets = this.injectedArgs.rules.reduce((prev, rule) => {
      (prev[rule.definition.granularity.toString()] ??=
           [] as Array<RuleExecutorClass<C, G, A>>)
          .push(rule);
      return prev;
    }, {} as Record<string, Array<RuleExecutorClass<C, G, A>>>);

    for (const [sheetName, ruleClasses] of Object.entries(sheets)) {
      const ruleSheet =
          getOrCreateSheet(`${RULE_SETTINGS_SHEET} - ${sheetName}`);
      ruleSheet.getRange('A:Z').clearDataValidations();
      const rules = new this.injectedArgs.ruleRangeClass(
          ruleSheet.getDataRange().getValues(), this.client);
      let currentOffset = numberOfHeaders +
          1;  // includes campaignID and campaign name (1-based index).
      const offsets: Record<string, number> = {};

      for (const rule of ruleClasses) {
        await rules.fillRuleValues(rule.definition);
        const ruleValues = rules.getRule(rule.definition.name);
        this.client.addRule(
            rule,
            ruleValues,
        );
        offsets[rule.definition.name] = currentOffset - 1;
        currentOffset += ruleValues[0].length - 1;
      }
      const values = rules.getValues();
      ruleSheet.clear();
      if (ruleSheet.getMaxRows() > values.length + 1) {
        ruleSheet.deleteRows(
            values.length + 1, ruleSheet.getMaxRows() - (values.length + 1));
      }
      if (ruleSheet.getMaxColumns() > values.length + 1) {
        ruleSheet.deleteColumns(
            values[0].length + 1, ruleSheet.getMaxColumns() - (values[0].length + 1));
      }
      ruleSheet.getRange(1, 1, values.length, values[0].length)
          .setValues(values);
      SpreadsheetApp.flush();
      for (const rule of ruleClasses) {
        Object.values(rule.definition.params).forEach((param, idx) => {
          this.addValidation(
              ruleSheet, param, offsets[rule.definition.name] + idx);
        });
      }
      ruleSheet.getBandings().forEach(b => {b.remove()});
      ruleSheet.getDataRange().breakApart();
      ruleSheet.getDataRange().applyRowBanding(
          SpreadsheetApp.BandingTheme.BLUE);

      let lastStart = 3;
      for (const offset of Object.values(offsets)) {
        if (offset > lastStart) {
          ruleSheet.getRange(1, lastStart, 1, offset - lastStart).merge();
          ruleSheet.getRange(2, lastStart, 1, offset - lastStart).merge();
          lastStart = offset;
        }
      }
    }
  }

  /** Adds the validation at the desired column. */
  addValidation(
      sheet: GoogleAppsScript.Spreadsheet.Sheet,
      {validationFormulas, numberFormat}:
          Pick<ParamDefinition, 'validationFormulas'|'numberFormat'>,
      column: number) {
    if (!validationFormulas || !validationFormulas.length) {
      return;
    }
    const validationBuilder = SpreadsheetApp.newDataValidation();
    for (const validationFormula of validationFormulas) {
      validationBuilder.requireFormulaSatisfied(validationFormula);
    }
    const range = sheet.getRange(4, column, sheet.getLastRow() - 3, 1);
    range.setDataValidation(validationBuilder.build());
    if (numberFormat) {
      range.setNumberFormat(numberFormat);
    }
  }

  abstract getIdentity(): A|null;

  /**
   * Runs rules for all campaigns/insertion orders and returns a scorecard.
   */
  async preLaunchQa() {
    type Rule = RuleExecutor<C, G, A, Record<string, ParamDefinition>>;
    const identity = this.getIdentity();
    if (!identity) {
      throw new Error(
          'Missing Advertiser ID - Please fill this out before continuing.');
    }

    const report: {[rule: string]: {[campaignId: string]: Value}} = {};
    await this.initializeRules();
    const thresholds: Array<[Rule, Promise<{values: Values}>]> =
        Object.values(this.client.ruleStore).map((rule) => {
          return [rule, rule.run()];
        });

    for (const [rule, threshold] of thresholds) {
      const {values} = await threshold;
      for (const value of Object.values(values)) {
        const fieldKey =
            Object.entries(value.fields ?? [['', 'all']])
                .map(([key, value]) => key ? `${key}: ${value}` : '')
                .join(', ');
        report[rule.name] = report[rule.name] || {};
        // overwrite with the latest `Value` until there's nothing left.
        report[rule.name][fieldKey] = value;
      }
    }

    const sheet = getOrCreateSheet('Pre-Launch QA Results');
    const lastUpdated =
        [`Last Updated ${new Date(Date.now()).toISOString()}`, '', '', ''];
    const headers = ['Rule', 'Field', 'Value', 'Anomaly'];
    const valueArray = [
      lastUpdated,
      headers,
      ...Object.entries(report).flatMap(
          ([key, values]):
              string[][] => {
                return Object.entries(values).map(
                    ([fieldKey, value]):
                        string[] => {
                          return [
                            key, fieldKey, String(value.value),
                            String(value.anomalous)
                          ];
                        },
                );
              }),
    ];
    sheet.getRange('A:Z').clearDataValidations();
    sheet.clear();
    sheet.getRange(1, 1, valueArray.length, valueArray[0].length)
        .setValues(valueArray);
  }

  /**
   * Runs an hourly, tracked validation stage.
   *
   * This should be run on a schedule. It's intentionally not exposed to the
   * UI as a menu because it would interfere with the scheduled runs.
   */
  async launchMonitor() {
    await this.initializeSheets();
    const {rules, results} = await this.client.validate();
    this.saveSettingsBackToSheets(Object.values(rules));
    this.populateRuleResultsInSheets(rules, results);
    this.maybeSendEmailAlert();
  }

  displayGlossary() {
    const template = HtmlService.createTemplateFromFile('html/glossary');
    template['rules'] = this.getFrontEndDefinitions();
    SpreadsheetApp.getUi().showSidebar(template.evaluate());
  }

  displaySetupGuide() {
    SpreadsheetApp.getUi().showSidebar(
        HtmlService.createHtmlOutputFromFile('html/guide'));
  }

  getFrontEndDefinitions() {
    return this.rules.map(rule => rule.definition);
  }

  /**
   * Given an array of rules, returns a 2-d array representation.
   */
  getMatrixOfResults(valueLabel: string, values: Value[], filter?: (value: Value) => boolean): string[][] {
    const headers = Object.keys(values[0]);
    const matrix = [[
      valueLabel, headers[1], ...Object.keys(values[0].fields || {}).map(String)
    ]];
    for (const value of values) {
      if (filter && !filter(value)) {
        continue;
      }
      const row = Object.values(value);
      matrix.push([
        ...row.slice(0, 2).map(String),
        ...Object.values(row[2] || []).map(String)
      ]);
    }
    return matrix;
  }

  /**
   * Converts a 2-d array to a CSV.
   *
   * Exported for testing.
   */
  matrixToCsv(matrix: string[][]): string {
    // note - the arrays we're using get API data, not user input. Not
    // anticipating anything that complicated, but we're adding tests to be
    // sure.
    return matrix
        .map(row => row.map(col => `"${col.replaceAll('"', '"""')}"`).join(','))
        .join('\n');
  }

  /**
   * Exports rules as a CSV.
   *
   */
  exportAsCsv(ruleName: string, matrix: string[][]) {
    const file = Utilities.newBlob(this.matrixToCsv(matrix));
    const folder = this.getOrCreateFolder('reports');
    const sheetId = HELPERS.getSheetId();
    const label: string = this.getRangeByName('LABEL').getValue();
    const filename = `${this.category}_${label ? label + '_' : 'report_'}${
        ruleName}_${sheetId}_${new Date(Date.now()).toISOString()}`;
    Drive.Files!.insert(
        {
          parents: [{id: folder}],
          title: `${filename}.csv`,
          mimeType: 'text/plain'
        },
        file);
    console.log(`Exported CSV launch_monitor/${filename} to Google Drive`);
  }

  /**
   * Creates a folder if it doesn't exist. Optionally adds it to the Drive ID.
   *
   * @param folderName The name of the folder to create or use.
   *   Should be owned by Apps Script.
   */
  getOrCreateFolder(folderName: string, parent?: GoogleAppsScript.Spreadsheet.Range): string {
    const parentId = parent ?? this.getRangeByName('DRIVE_ID');
    if (!parentId || !parentId.getValue()) {
      throw new Error(
          'Missing a named range and/or a value in named range `DRIVE_ID`.');
    }
    const driveId: string = parentId.getValue().trim();

    const file: GoogleAppsScript.Drive.Schema.File|undefined =
        Drive.Files!.get(driveId);
    let parentName = '';
    if (file && file.id) {
      if (file.mimeType !== FOLDER) {
        throw new Error(
            'The selected Google Drive file ID is not a folder. Please delete and/or add a folder ID');
      }
      parentName = file.id;
    }

    const q = (parentName ? `'${parentName}' in parents and ` : '') +
        `title="${folderName}" and mimeType="${FOLDER}" and not trashed`;
    const args = {
      q,
    };
    const folders = Drive.Files!.list(args).items;
    let folder: string;
    if (folders && folders.length) {
      folder = folders[0].id as string;
    } else {
      folder = Drive.Files!.insert({
        title: folderName,
        mimeType: FOLDER,
        parents: [{id: driveId}],
      }).id as string;
    }
    return folder;
  }

  populateRuleResultsInSheets(rules: Record<string, RuleExecutor<C, G, A, Record<string, ParamDefinition>>>, results: Record<string, ExecutorResult>) {
    const ruleSheets: string[] = [];
    for (const [uniqueKey, result] of Object.entries(results)) {
      const rule = rules[uniqueKey];
      const ruleSheet = `${rule.name} - Results`;
      ruleSheets.push(rule.name);
      const sheet = getOrCreateSheet(ruleSheet);
      sheet.clear();
      const values = Object.values(result.values);
      if (!values.length) {
        continue;
      }
      const unfilteredMatrix =
          this.getMatrixOfResults(rule.valueFormat.label, values, value => value.anomalous);
      const matrix = unfilteredMatrix.filter(
          row => row.length === unfilteredMatrix[0].length);
      if (!matrix.length || !matrix[0].length) {
        continue;
      }
      if (matrix.length !== unfilteredMatrix.length) {
        console.error(`Dropped ${
            unfilteredMatrix.length - matrix.length} malformed records.`);
      }
      sheet.getRange(1, 1, matrix.length, matrix[0].length).setValues(matrix);
      if (rule.valueFormat.numberFormat) {
        sheet.getRange(2, 1, matrix.length - 1, 1)
            .setNumberFormat(rule.valueFormat.numberFormat);
      }

      if (getTemplateSetting('LAUNCH_MONITOR_OPTION').getValue() ===
          'CSV Back-Up') {
        this.exportAsCsv(rule.name, matrix);
      }
    }
    getOrCreateSheet('Summary')
        .getRange(1, 1, ruleSheets.length, 2)
        .setValues(ruleSheets.map(
            (rule, i) =>
                [rule,
                 `=COUNTIF(INDIRECT("'" & A${i+1} & " - Results'!B:B"), TRUE)`,
    ]));
  }

  getRangeByName(name: string) {
    const range = SpreadsheetApp.getActive().getRangeByName(name);
    if (!range) {
      throw new Error(`Missing an expected range '${
          name}'. You may need to get a new version of this sheet from the template.`);
    }

    return range;
  }

  displaySetupModal() {}

  /**
   * Validates settings sheets exist and that they are up-to-date.
   */
  async initializeSheets() {
    if (!this.getIdentity()) {
      let advertiserId = '';

      while (!advertiserId) {
        this.displaySetupModal();
      }
      getTemplateSetting('ID').setValue(advertiserId);
    }

    this.migrate();

    await this.initializeRules();
  }

  /**
   * Handle migrations for Google Sheets (sheets getting added/removed).
   */
  migrate(): number {
    const sheetVersion =
        PropertiesService.getScriptProperties().getProperty('sheet_version') ??
        '0';
    let numberOfMigrations = 0;
    if (!sheetVersion) {
      PropertiesService.getScriptProperties().setProperty(
          'sheet_version', this.injectedArgs.version);
    }

    const migrations = Object.entries(this.injectedArgs.migrations)
                           .sort((t1, t2) => sortMigrations(t1[0], t2[0]));

    for (const [version, migration] of migrations) {
      if (sortMigrations(version, this.injectedArgs.version) >= 0) {
        break;
      }
      if (sortMigrations(version, sheetVersion) > 0) {
        migration(this as unknown as F);
        // write manually each time because we want incremental migrations if
        // anything fails.
        PropertiesService.getScriptProperties().setProperty(
            'sheet_version', version);
        ++numberOfMigrations;
      }
    }
    if (sheetVersion !== this.injectedArgs.version) {
      PropertiesService.getScriptProperties().setProperty(
          'sheet_version', String(this.injectedArgs.version));
    }
    return numberOfMigrations;
  }

  abstract maybeSendEmailAlert(): void;
  protected saveSettingsBackToSheets(
      rules: Array<RuleExecutor<C, G, A, Record<string, ParamDefinition>>>) {
    const ranges = new Map<G, RuleRangeInterface<C, G, A>>();

    for (const rule of rules) {
      if (!ranges.get(rule.granularity)) {
        ranges.set(rule.granularity, new this.injectedArgs.ruleRangeClass(
            getOrCreateSheet(`${RULE_SETTINGS_SHEET} - ${rule.granularity}`)
                .getDataRange()
                .getValues(),
            this.client));
      }
      const rules = ranges.get(rule.granularity)!;

      for (const [id, column] of rule.settings.entries()) {
        rules.setRow(rule.name, id, column);
      }
    }

    for (const [granularity, range] of ranges.entries()) {
      range.writeBack(granularity);
    }
  }
}

/**
 * Creates new rule with the metadata needed to generate settings.
 *
 * Wrapping in this function gives us access to all methods in {@link
 * RuleUtilities} as part of `this` in our `callback`.
 *
 * Example:
 *
 * ```
 * newRule({
 *   //...
 *   callback(client, settings) {
 *     const rule = this.getRule(); // the `RuleGetter`
 *     const rule = rule.getValues();
 *     //...
 *   }
 * });
 * ```
 */
export function
newRuleBuilder<C extends BaseClientInterface<C, G, A>, G extends
                   RuleGranularity<G>, A extends BaseClientArgs<C, G, A>>():
    <P extends Record<keyof P, ParamDefinition>>(p: RuleParams<C, G, A, P>) =>
        RuleExecutorClass<C, G, A, P> {
  return function newRule<P extends Record<keyof P, ParamDefinition>>(
      ruleDefinition: RuleParams<C, G, A, P>): RuleExecutorClass<C, G, A, P> {
    const ruleClass = class implements RuleExecutor<C, G, A, P> {
      readonly uniqueKeyPrefix: string = '';
      readonly description = ruleDefinition.description;
      readonly settings: Settings<Record<keyof P, string>>;
      readonly name: string = ruleDefinition.name;
      readonly params = ruleDefinition.params;
      readonly helper = ruleDefinition.helper ?? '';
      // Auto-added to unblock TS5.0 migration
      // @ts-ignore(go/ts50upgrade): This syntax requires an imported helper
      // named
      // '__setFunctionName' which does not exist in 'tslib'. Consider upgrading
      // your version of 'tslib'.
      readonly granularity: G = ruleDefinition.granularity;
      readonly valueFormat = ruleDefinition.valueFormat;
      // TODO: go/ts50upgrade - Auto-added to unblock TS5.0 migration
      //   TS2343: This syntax requires an imported helper named '__setFunctionName' which does not exist in 'tslib'. Consider upgrading your version of 'tslib'.
      // @ts-ignore
      static definition = ruleDefinition;

      constructor(readonly client: C, settingsArray: readonly string[][]) {
        this.uniqueKeyPrefix = ruleDefinition.uniqueKeyPrefix;
        this.settings = transformToParamValues(settingsArray, this.params);
      }

      async run() {
        return await ruleDefinition.callback.bind(this)();
      }

      getRule() {
        return getRule(this.getUniqueKey(), this.client.properties);
      }

      getUniqueKey() {
        return this.client.getUniqueKey(ruleDefinition.uniqueKeyPrefix);
      }
    };

    Object.defineProperty(ruleClass, 'name', {value: ruleDefinition.name});
    return ruleClass;
  };
}

// Lazy load frontend.
function
load<C extends BaseClientInterface<C, G, A>, G extends RuleGranularity<G>,
                                                       A extends
         BaseClientArgs<C, G, A>, F extends AppsScriptFrontEnd<C, G, A, F>>(
    frontEndCaller: ScriptFunction<F>, fnName: ScriptEntryPoints) {
  return (scriptProperties: PropertyStore|
          GoogleAppsScript.Events.AppsScriptEvent) => {
    const frontend = frontEndCaller(
        scriptProperties && scriptProperties.hasOwnProperty('getProperty') ?
            scriptProperties as PropertyStore :
            new AppsScriptPropertyStore());
    switch (fnName) {
      case 'onOpen':
        return frontend.onOpen();
      case 'initializeSheets':
        return frontend.initializeSheets();
      case 'preLaunchQa':
        return frontend.preLaunchQa();
      case 'launchMonitor':
        return frontend.launchMonitor();
      case 'displaySetupGuide':
        frontend.displaySetupGuide();
        return;
      case 'displayGlossary':
        frontend.displayGlossary();
        return;
    }
  }
}

function applyBinding<C extends BaseClientInterface<C, G, A>,
                                G extends RuleGranularity<G>, A extends
                          BaseClientArgs<C, G, A>,
                          F extends AppsScriptFrontEnd<C, G, A, F>>(
    frontEndCaller: ScriptFunction<F>): ScriptFunction<F> {
  return (scriptProperties: PropertyStore) => {
    const frontend = frontEndCaller(scriptProperties);
    toExport.onOpen = frontend.onOpen.bind(frontend);
    toExport.initializeSheets = frontend.initializeSheets.bind(frontend);
    toExport.preLaunchQa = frontend.preLaunchQa.bind(frontend);
    toExport.launchMonitor = frontend.launchMonitor.bind(frontend);

    return frontend;
  };
}

/**
 * Primary entry point for an Apps Script implementation.
 * @param frontEndCaller A callable that late binds {@link toExport} to the
 *   correct functions from a frontend. A correct implementation of this
 *   function will initialize a {@link AppsScriptFrontEnd} class and assign
 *   all functions the first time it's called.
 */
export function lazyLoadApp<C extends BaseClientInterface<C, G, A>,
                                      G extends RuleGranularity<G>, A extends
                                BaseClientArgs<C, G, A>,
                                F extends AppsScriptFrontEnd<C, G, A, F>>(
    frontEndCaller: ScriptFunction<F>): ScriptFunction<F> {
  const binders = applyBinding<C, G, A, F>(frontEndCaller);
  toExport.onOpen = load<C, G, A, F>(binders, 'onOpen');
  toExport.initializeSheets = load<C, G, A, F>(binders, 'initializeSheets');
  toExport.preLaunchQa = load<C, G, A, F>(binders, 'preLaunchQa');
  toExport.launchMonitor = load<C, G, A, F>(binders, 'launchMonitor');
  toExport.displayGlossary = load<C, G, A, F>(binders, 'displayGlossary');
  toExport.displaySetupGuide = load<C, G, A, F>(binders, 'displaySetupGuide');

  return binders;
}

/**
 * Create a well-formatted setting with a bold headline and a small description.
 *
 * Uses rich-text to put the info into a single cell.
 * @param sheet The spreadsheet to change.
 * @param rangeName The range to adjust (A1 notation).
 * @param text A tuple. The first value is the headline and the second the
 *     description.
 */
export function addSettingWithDescription(
    sheet: GoogleAppsScript.Spreadsheet.Sheet, rangeName: string,
    text: [headline: string, description: string]) {
  const bold = SpreadsheetApp.newTextStyle().setBold(true).build();
  const small =
      SpreadsheetApp.newTextStyle().setFontSize(8).setItalic(true).build();
  sheet.getRange(rangeName).setRichTextValue(
      SpreadsheetApp.newRichTextValue()
          .setText(text.join('\n'))
          .setTextStyle(0, text[0].length, bold)
          .setTextStyle(text[0].length, text[0].length + text[1].length, small)
          .build());
}

/***
 * A list of modules we need in the global scope for AppsScript to function.
 */
export const toExport: Record<AppsScriptFunctions, Function> = {
  onOpen: () => {},
  initializeSheets: () => {},
  preLaunchQa: () => {},
  launchMonitor: () => {},
  displayGlossary: () => {},
  displaySetupGuide: () => {},
};

/**
 * Given two string semver values, checks to see which one is larger.
 *
 * Given '1.2.1' and '1.1.0', the result will be 0.1.1, which would sort the
 * second value as higher than the first value.
 *
 * @param ver1 A semver value
 * @param ver2 A semver value
 */
export function sortMigrations(ver1: string, ver2: string) {
  const keys1 = ver1.split('.').map(Number);
  const keys2 = ver2.split('.').map(Number);
  let difference = 0;
  for (let i = 0; i < Math.max(keys1.length, keys2.length); i++) {
    difference += ((keys1[i] ?? 0) - (keys2[i] ?? 0)) / (10 ** i);
  }
  return difference;
}