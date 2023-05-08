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

import {BaseClientInterface, ParamDefinition, RecordInfo, RuleDefinition, SettingMapInterface} from './types';

/**
 * Provides a useful data structure to get campaign ID settings.
 *
 * Defaults to the row with campaignId: 'default' if no campaign ID override is
 * set.
 */
export class SettingMap<P extends {[Property in keyof P]: P[keyof P]}> implements SettingMapInterface<P> {
  private readonly map: Map<string, P>;
  private readonly keys: string[];

  constructor(values: Array<[string, P]>) {
    this.map = new Map(values);
    this.keys = Object.keys(values[0][1]);
  }

  getOrDefault(campaignId: string): P {
    const defaultValue =
        this.map.get('default') || {} as Record<string, string>;
    const campaignValue =
        this.map.get(campaignId) || {} as Record<string, string>;
    return this.keys.reduce((prev, key) => {
      prev[key] = (!(key in campaignValue) || campaignValue[key] === '' ? defaultValue[key] : campaignValue[key]) ?? '';
      return prev;
    }, {} as Record<string, string>) as unknown as P;
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
 * @param mapper Maps internal params to the user-facing definition e.g. {param1: {title: 'My Param 1'}}
 */
export function transformToParamValues<MapType extends Record<keyof MapType, ParamDefinition>>(rawSettings: readonly string[][], mapper: MapType) {
  if (rawSettings.length < 2) {
    throw new Error('Expected a grid with row and column headers of at least size 2');
  }
  const headers = rawSettings[0];
  const body = rawSettings.slice(1);

  function forEachRow(row: readonly string[]): [string, {[Property in keyof MapType]: string}] {
    return [
      row[0],
      Object.fromEntries(
          Object.entries<ParamDefinition>(mapper).map(([param, {label}]) => {
            const i = headers.indexOf(label);
            return [param, row[i]];
          })
      ) as {[Property in keyof MapType]: string},
    ];
  }
  return new SettingMap(body.map(forEachRow));
}

function makeCampaignIndexedSettings(headers: string[], currentSettings: string[][]): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (let i = 0; i < currentSettings.length; i++) {
    const campaignId = currentSettings[i][0];
    for (let c = 1; c < currentSettings[i].length; c++) {
      (result[campaignId] = result[campaignId] ?? {})[headers[c-1]] = currentSettings[i][c];
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
export abstract class AbstractRuleRange<C extends BaseClientInterface<C, Granularity>, Granularity extends {[Property in keyof Granularity]: Granularity}> {
  private readonly rowIndex: Record<string, number> = {};
  private readonly columnOrders: Record<string, Record<string, number>> = {};
  private readonly rules: Record<string, string[][]> & Record<'none', string[][]> = {'none': [[]]};

  constructor(range: string[][], protected readonly client: C, headers: string[] = ['ID', 'default']) {
    let start = 0;
    let col: number;
    for (let i = 0; i < headers.length; i++) {
      this.rowIndex[headers[i]] = i;
    }
    for (col = 0; col < range[0].length; col++) {
      if (range[0][col]) {
        const ruleRange = range.map(r => [r[0], ...r.slice(start, col)]).slice(1);
        this.setRule(range[0][start] || 'none', ruleRange);
        start = col;
      }
    }
    const ruleRange = range.map(row => [row[0], ...row.slice(start, col)]).slice(1);
    this.setRule(range[0][start] || 'none', ruleRange);
  }

  setRow(category: string, campaignId: string, column: string[]): void {
    if (campaignId === "") {
      return;
    }
    this.rowIndex[campaignId] = this.rowIndex[campaignId] ?? Object.keys(this.rowIndex).length;
    (this.rules[category] = this.rules[category] || [])[this.rowIndex[campaignId]] = column;
  }

  /**
   * Given a 2-d array formatted like a rule sheet, create a {@link RuleRange}.
   *
   * A rule sheet contains the following structure:
   *
   *    ,,Category A,,Category B,,
   *    header1,header2,header3,header4,header5,header6,header7
   *    none1,none2,cata1,cata2,catb1,catb2,catb3
   */
  getValues(ruleGranularity?: Granularity): string[][] {
    const values =
        Object.entries(this.rules).reduce((prev, [category, rangeRaw]) => {
          const range = rangeRaw.filter(row => row && row.length);
          if (ruleGranularity && (category === 'none' || this.client.ruleStore[category].granularity !== ruleGranularity)) {
            return prev;
          }
          const length = range.length ? range[0].length : 0;
          if (!length) {
            return prev;
          }
          const offset = prev[0].length;
          prev[0] = prev[0].concat(
              Array.from({length}).fill(category === 'none' ? '' : category) as
                  string[]);

          prev[1] = category === 'none' ?
              ['', ''] :
              prev[1].concat(Array.from<string>({length}).fill('').map(
                  (cell, idx) => idx === 0 ?
                      this.client.ruleStore[prev[0][idx + offset]].helper ??
                      '' :
                      ''));
          Object.values(this.rowIndex)
              .sort((x: number, y: number) => x - y)
              .forEach((value, r) => {
                prev[r + 2] =
                    (prev[r + 2] = prev[r + 2] || [])
                        .concat((
                            range[r] ?? Array.from<string>({length}).fill('')));
              });
          return prev;
        }, [[], []] as string[][]);

    for (let c = values[0].length - 1; c > 0; c--) {
      values[0][c] = values[0][c - 1] === values[0][c] ? '' : values[0][c];
    }

    return values;
  }

  getRule(ruleName: string): string[][] {
    if (!this.rules[ruleName] || !this.rules[ruleName].length) {
      return [];
    }
    return Object.values(this.rowIndex).filter(
        (index) => this.rules['none'][index] && this.rules[ruleName][index]
    ).sort((a, b) => a - b).map((index) => {
      return [this.rules['none'][index][0], ...this.rules[ruleName][index]];
    });
  }

  setRule(ruleName: string, ruleValues: string[][]) {
    for (let r = 0; r < ruleValues.length; r++) {
      this.setRow(ruleName, ruleValues[r][0], ruleValues[r].slice(1));
    }
  }

  async fillRuleValues<Params>(rule:
      Pick<RuleDefinition<Record<keyof Params, ParamDefinition>, Granularity>, 'name'|'params'|'defaults'|'granularity'>) {

    if (!rule.defaults) {
      throw new Error('Missing default values definition in fillRow');
    }

    const headersByIndex: {[index: number]: string} = {};
    const paramsByHeader: {[index: string]: keyof Params} = {};
    const indexByHeader: {[header: string]: number} = {};
    Object.entries<ParamDefinition>(rule.params).forEach(([key, {label}], index) => {
      headersByIndex[index] = label;
      paramsByHeader[label] = key as keyof Params;
      indexByHeader[label] = index;
    });
    this.columnOrders[rule.name] = this.columnOrders[rule.name] || indexByHeader;
    const ruleValues = this.getRule(rule.name);
    const currentSettings = makeCampaignIndexedSettings(ruleValues[0] ? ruleValues[0].slice(1) : [], ruleValues);
    const length = Object.keys(rule.params).length;

    this.setRow('none', 'ID', ['ID', 'Campaign Name']);
    this.setRow(rule.name, 'ID', [...Object.values(headersByIndex)]);
    this.setRow('none', 'default', ['default', '']);
    this.setRow(
      rule.name,
      'default',
      Array.from({length}).map((unused, index) =>
          currentSettings && currentSettings['default'] ?
              currentSettings['default'][headersByIndex[index]] ?? rule.defaults[paramsByHeader[headersByIndex[index]]] :
              rule.defaults[paramsByHeader[headersByIndex[index]]]
      ));
    for (const record of await this.getRows(rule.granularity)) {
      this.setRow(rule.name, record.id,
          Array.from({length})
              .map(
                  (unused, index) =>
                      currentSettings && currentSettings[record.id] ?
                          currentSettings[record.id][headersByIndex[index]] ??
                          '' :
                          '')
      );
      this.setRow('none', record.id, [record.id , record.displayName]);
    }
  }

  abstract getRows(granularity: Granularity): Promise<RecordInfo[]>;
}

/**
 * Convenience method to optionally create, then retrieve a sheet by name.
 */
export function getOrCreateSheet(sheetName: string) {
  const active = SpreadsheetApp.getActive();
  return active.getSheetByName(sheetName) || active.insertSheet(sheetName);
}

/**
 * Helpers that can be stubbed in tests for migrations.
 */
export const HELPERS = {
  applyAnomalyFilter(range: GoogleAppsScript.Spreadsheet.Range, column: number) {
    const criteria = SpreadsheetApp.newFilterCriteria().whenTextEqualTo('TRUE');
    const filter = range.getSheet().getFilter();
    filter && filter.remove();
    range.createFilter().setColumnFilterCriteria(4, criteria.build());
  }
};
