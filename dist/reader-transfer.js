import { READER_PRESET_LIMITS, readerPresetSnapshot, persistReaderPresets, persistReadMarks } from './local-state.js?v=0.2.40';
import { READ_MARK_LIMIT, restoreReadMarks } from './read-progress.js?v=0.2.40';

export const READER_TRANSFER_MAX_BYTES = 8 * 1024 * 1024;
const groups = ['readerPresets', 'readMarks'];

function normalizedMark(value) {
  return restoreReadMarks([value]).marks[0];
}

export function readerTransferFile({ readerPresets, readMarks }) {
  return { app: 'bioscope-reader', version: 1, readerPresets: readerPresets.map(readerPresetSnapshot).filter(Boolean),
    readMarks: restoreReadMarks(readMarks).marks };
}

export function createReaderTransferBlob(current) {
  const blob = new Blob([JSON.stringify(readerTransferFile(current))], { type: 'application/json;charset=utf-8' });
  if (blob.size > READER_TRANSFER_MAX_BYTES) throw new Error('阅读数据文件超过 8 MB 上限，导出未生成。');
  return blob;
}

export async function readReaderTransferFile(file) {
  if (file.size > READER_TRANSFER_MAX_BYTES) throw new Error('文件超过 8 MB 上限。');
  const content = await file.text();
  try { return JSON.parse(content); }
  catch { throw new Error('文件格式无效，无法读取 JSON。'); }
}

function mergeGroup(existing, incoming, normalize, limit, conflictKeys = () => []) {
  const values = [...existing];
  const seen = new Set(existing.map(value => JSON.stringify(value)));
  const conflicts = new Set(existing.flatMap(conflictKeys));
  const counts = { added: 0, repeat: 0, conflict: 0, invalid: 0, overflow: 0 };
  for (const entry of incoming) {
    const value = normalize(entry);
    if (!value) { counts.invalid++; continue; }
    const exact = JSON.stringify(value);
    if (seen.has(exact)) { counts.repeat++; continue; }
    const keys = conflictKeys(value);
    if (keys.some(key => conflicts.has(key))) { counts.conflict++; continue; }
    if (values.length >= limit) { counts.overflow++; continue; }
    values.push(value);
    seen.add(exact);
    for (const key of keys) conflicts.add(key);
    counts.added++;
  }
  return { values, counts };
}

export function prepareReaderTransfer(data, { readerPresets, readMarks, expectedRaw }) {
  if (data?.app !== 'bioscope-reader' || data.version !== 1 || !groups.every(key => Array.isArray(data[key]))) {
    throw new Error('请选择 BioScope 阅读数据 v1 文件。');
  }
  return {
    expectedRaw: { ...expectedRaw },
    readerPresets: mergeGroup(readerPresets, data.readerPresets, readerPresetSnapshot, READER_PRESET_LIMITS.count,
      preset => [`id:${preset.id}`, `name:${preset.name.normalize('NFC')}`]),
    readMarks: mergeGroup(readMarks, data.readMarks, normalizedMark, READ_MARK_LIMIT),
  };
}

export function checkReaderTransferStorage(storage, expectedRaw, protectedKeys, prefix = 'bioscope.v1.') {
  const outcomes = {};
  for (const key of groups) {
    if (protectedKeys.has(key)) outcomes[key] = { status: 'protected' };
    try {
      if (storage.getItem(prefix + key) !== expectedRaw[key]) return { stale: true, outcomes: {} };
    } catch { outcomes[key] ??= { status: 'failed' }; }
  }
  return { stale: false, outcomes };
}

export function persistReaderTransfer(storage, preview, protectedKeys, prefix = 'bioscope.v1.') {
  // Preflight both groups before the first write. The guarded writers also
  // compare each raw value again directly before that group's own write.
  const inspected = checkReaderTransferStorage(storage, preview.expectedRaw, protectedKeys, prefix);
  if (inspected.stale) return inspected;
  const { outcomes } = inspected;
  const writers = { readerPresets: persistReaderPresets, readMarks: persistReadMarks };
  for (const key of groups) {
    if (outcomes[key]) continue;
    if (!preview[key].counts.added) { outcomes[key] = { status: 'unchanged' }; continue; }
    outcomes[key] = writers[key](storage, preview[key].values, preview.expectedRaw[key], prefix);
  }
  return inspected;
}
