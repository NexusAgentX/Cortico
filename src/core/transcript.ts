/**
 * transcript:主 session 的只追加副本,`data/runs/<run>/transcript.jsonl`。
 *
 * session-main.jsonl 是上下文,交接与前缀重载会整文件重写;这里每次 append 一行,
 * 交接、清空、前缀重载各写一条边界记录。思维链与工具回执全文只在这里按墙钟连续。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ContextRecord } from '../protocol/open-responses/context.ts';
import { currentAnchors } from './log-context.ts';
import { nowIso } from './util.ts';

export type TranscriptBoundary = 'handoff' | 'clear' | 'prefix-reload' | 'ephemeral-drop';

export interface TranscriptItemRecord {
  kind: 'item';
  ts: string;
  run: string;
  sess?: string;
  round?: number;
  /** session 里的下标(append 时刻) */
  index: number;
  item: ContextRecord['item'];
  context: ContextRecord['context'];
}

export interface TranscriptBoundaryRecord {
  kind: 'boundary';
  ts: string;
  run: string;
  sess?: string;
  round?: number;
  event: TranscriptBoundary;
  data: Record<string, unknown>;
}

export type TranscriptRecord = TranscriptItemRecord | TranscriptBoundaryRecord;

export interface TranscriptOptions {
  run?: string;
  timezone?: string;
}

export class Transcript {
  private readonly run: string;
  private readonly timezone: string;
  private dirReady = false;

  constructor(private readonly file: string | null, opts: TranscriptOptions = {}) {
    this.run = opts.run ?? 'r-none';
    this.timezone = opts.timezone ?? 'Asia/Shanghai';
  }

  item(record: ContextRecord, index: number): void {
    const anchors = currentAnchors();
    this.append({
      kind: 'item',
      ts: record.context.ts ?? nowIso(this.timezone),
      run: this.run,
      ...(anchors.sess !== undefined ? { sess: anchors.sess } : {}),
      ...(anchors.round !== undefined ? { round: anchors.round } : {}),
      index,
      item: record.item,
      context: record.context,
    });
  }

  boundary(event: TranscriptBoundary, data: Record<string, unknown>): void {
    const anchors = currentAnchors();
    this.append({
      kind: 'boundary',
      ts: nowIso(this.timezone),
      run: this.run,
      ...(anchors.sess !== undefined ? { sess: anchors.sess } : {}),
      ...(anchors.round !== undefined ? { round: anchors.round } : {}),
      event,
      data,
    });
  }

  private append(record: TranscriptRecord): void {
    if (!this.file) return;
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.file), { recursive: true });
        this.dirReady = true;
      }
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      // 写不进去不影响运行
    }
  }
}
