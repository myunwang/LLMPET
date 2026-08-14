'use strict';

// Zstandard 分帧读取 —— 只为 dsh-watch 服务的最小实现。
//
// DeepSeek Harness 的会话日志 session.jsonl.zstd 不是「一整个 zstd 文件」，
// 而是**独立帧串联**：第一帧只装 header 行，之后每次落盘（一个写入批次）追加
// 一帧。这个形状带来两个必须自己处理的事：
//
//   1. 一次性解压整个文件是错的。Node 22 的 zlib.zstdDecompressSync 遇到串联帧
//      只解第一帧就返回（实测：三帧文件只吐出 header 行）——必须先切帧、再逐帧解。
//   2. 尾部随时可能是半帧。桌宠是边写边读，最后一帧常常只写了一半；解半帧会报错，
//      所以先做**结构化扫描**（只读帧头/块头，不解压）定位完整帧边界，半帧留到下一轮。
//
// 扫描逻辑对齐 dsh 自己的 packages/session/session-persistence-jsonl/src/zstd.ts
// （scanZstdFrames），字段含义按 RFC 8878 的 Frame_Header_Descriptor。
//
// 解码器优先用 Node 原生（将来 Electron 升到 Node ≥22.15 自动切过去），
// 否则回落到内置的纯 JS fzstd —— 当前 Electron 33 = Node 20.18，走的就是回落路径。

const zlib = require('zlib');

const ZSTD_MAGIC = 0xFD2FB528;
// 跳过帧（skippable frame）的 magic：0x184D2A50..0x184D2A5F，长度显式给出。
const SKIP_MAGIC_MASK = 0xFFFFFFF0;
const SKIP_MAGIC_BASE = 0x184D2A50;

const nativeDecompress = typeof zlib.zstdDecompressSync === 'function'
  ? zlib.zstdDecompressSync
  : null;
let fzstd = null; // 懒加载：没装 dsh 的机器永远不会碰这 24KB

/**
 * 结构化扫描串联帧，定位每个**完整**帧的字节区间。不解压、不校验内容。
 * @param {Buffer} buf 从帧边界开始的字节
 * @returns {{frames: Array<{start:number,end:number}>, tornStart?: number, error?: string}}
 *   frames 完整帧；tornStart 末尾半帧的起点（下一轮补齐再读）；
 *   error 结构坏了（不是 zstd 数据/保留位非法），调用方应放弃这个文件。
 */
function scanFrames(buf) {
  const frames = [];
  let offset = 0;

  while (offset < buf.length) {
    const start = offset;
    if (buf.length - offset < 4) return { frames, tornStart: start };
    const magic = buf.readUInt32LE(offset);

    // skippable frame：magic + 4 字节长度 + 该长度的内容，整体跳过
    if ((magic & SKIP_MAGIC_MASK) === SKIP_MAGIC_BASE) {
      if (buf.length - offset < 8) return { frames, tornStart: start };
      const size = buf.readUInt32LE(offset + 4);
      const end = offset + 8 + size;
      if (end > buf.length) return { frames, tornStart: start };
      offset = end;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      return { frames, error: `invalid frame magic at byte ${offset}` };
    }
    offset += 4;

    if (offset === buf.length) return { frames, tornStart: start };
    const descriptor = buf.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) {
      return { frames, error: `reserved frame-header bit at byte ${offset - 1}` };
    }
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag;
    // Window_Descriptor 只在非 single-segment 时存在
    const restHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buf.length - offset < restHeaderBytes) return { frames, tornStart: start };
    offset += restHeaderBytes;

    // 数据块链：每块 3 字节块头（末块标志 + 类型 + 大小），RLE 块内容固定 1 字节
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buf.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) {
        return { frames, error: `reserved block type at byte ${offset - 3}` };
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }

    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }

  return { frames };
}

/** 解压**一个完整帧**。抛错交给调用方兜（坏帧只丢这一帧的内容，不该打断轮询）。 */
function decodeFrame(frame) {
  if (nativeDecompress) return nativeDecompress(frame);
  if (!fzstd) fzstd = require('./vendor/fzstd');
  const out = fzstd.decompress(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

/**
 * 扫 + 解一步到位：返回完整帧的明文与「已消费到哪个字节」。
 * @param {Buffer} buf 从帧边界开始的字节
 * @returns {{text: string, consumed: number, error?: string}}
 *   consumed = 最后一个完整帧的末尾（半帧不计），调用方据此推进 offset。
 */
function decodeFrames(buf) {
  const scan = scanFrames(buf);
  const parts = [];
  let consumed = 0;
  for (const f of scan.frames) {
    try {
      parts.push(decodeFrame(buf.subarray(f.start, f.end)));
    } catch {
      // 单帧解不开（校验和坏 / 截断得刚好像完整帧）：跳过它继续，别卡死整条流
    }
    consumed = f.end;
  }
  const out = { text: parts.length ? Buffer.concat(parts).toString('utf8') : '', consumed };
  if (scan.error) out.error = scan.error;
  return out;
}

module.exports = { scanFrames, decodeFrame, decodeFrames, hasNativeZstd: !!nativeDecompress };
