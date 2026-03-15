import { describe, expect, it } from 'vitest';

import { parseNpzFile } from './NumpyIO';

const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

function writeUint16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((value & 1) !== 0) {
        value = 0xedb88320 ^ (value >>> 1);
      } else {
        value >>>= 1;
      }
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const lookupIndex = (crc ^ bytes[index]) & 0xff;
    crc = (crc >>> 8) ^ (CRC32_TABLE[lookupIndex] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeAscii(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function createNpyFloat64Vector(values: Float64Array): Uint8Array {
  const shapeToken = `${values.length},`;
  const headerBase = `{'descr': '<f8', 'fortran_order': False, 'shape': (${shapeToken}), }`;
  const magicLength = 6;
  const versionLength = 2;
  const headerLengthFieldSize = 2;
  const preambleLength = magicLength + versionLength + headerLengthFieldSize;
  let header = headerBase;
  let headerBytes = encodeAscii(header);
  let totalHeaderLength = preambleLength + headerBytes.length + 1;

  const paddingRemainder = totalHeaderLength % 16;
  const paddingSpaces = paddingRemainder === 0 ? 0 : 16 - paddingRemainder;
  if (paddingSpaces > 0) {
    header = `${header}${' '.repeat(paddingSpaces)}`;
    headerBytes = encodeAscii(header);
    totalHeaderLength = preambleLength + headerBytes.length + 1;
  }

  const output = new Uint8Array(totalHeaderLength + values.byteLength);
  output.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59], 0);
  output[6] = 1;
  output[7] = 0;
  writeUint16(output, 8, headerBytes.length + 1);
  output.set(headerBytes, 10);
  output[10 + headerBytes.length] = 0x0a;

  output.set(
    new Uint8Array(values.buffer, values.byteOffset, values.byteLength),
    totalHeaderLength,
  );
  return output;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const blobInput = new Uint8Array(bytes.byteLength);
  blobInput.set(bytes);
  const compressedStream = new Blob([blobInput]).stream().pipeThrough(
    new CompressionStream('deflate-raw'),
  );
  return new Uint8Array(await new Response(compressedStream).arrayBuffer());
}

interface ZipEntryInput {
  fileName: string;
  uncompressedData: Uint8Array;
}

async function createDeflatedNpz(entries: ZipEntryInput[]): Promise<Uint8Array> {
  const localFileRecords: Uint8Array[] = [];
  const centralDirectoryRecords: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const fileNameBytes = encodeAscii(entry.fileName);
    const compressedData = await deflateRaw(entry.uncompressedData);
    const crc32 = computeCrc32(entry.uncompressedData);

    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    writeUint32(localHeader, 0, ZIP_LOCAL_FILE_HEADER_SIGNATURE);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 0);
    writeUint16(localHeader, 8, 8);
    writeUint16(localHeader, 10, 0);
    writeUint16(localHeader, 12, 0);
    writeUint32(localHeader, 14, crc32);
    writeUint32(localHeader, 18, compressedData.length);
    writeUint32(localHeader, 22, entry.uncompressedData.length);
    writeUint16(localHeader, 26, fileNameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileNameBytes, 30);

    const localRecord = concatBytes([localHeader, compressedData]);
    localFileRecords.push(localRecord);

    const centralRecord = new Uint8Array(46 + fileNameBytes.length);
    writeUint32(centralRecord, 0, ZIP_CENTRAL_DIRECTORY_SIGNATURE);
    writeUint16(centralRecord, 4, 20);
    writeUint16(centralRecord, 6, 20);
    writeUint16(centralRecord, 8, 0);
    writeUint16(centralRecord, 10, 8);
    writeUint16(centralRecord, 12, 0);
    writeUint16(centralRecord, 14, 0);
    writeUint32(centralRecord, 16, crc32);
    writeUint32(centralRecord, 20, compressedData.length);
    writeUint32(centralRecord, 24, entry.uncompressedData.length);
    writeUint16(centralRecord, 28, fileNameBytes.length);
    writeUint16(centralRecord, 30, 0);
    writeUint16(centralRecord, 32, 0);
    writeUint16(centralRecord, 34, 0);
    writeUint16(centralRecord, 36, 0);
    writeUint32(centralRecord, 38, 0);
    writeUint32(centralRecord, 42, localOffset);
    centralRecord.set(fileNameBytes, 46);
    centralDirectoryRecords.push(centralRecord);

    localOffset += localRecord.length;
  }

  const localData = concatBytes(localFileRecords);
  const centralDirectory = concatBytes(centralDirectoryRecords);
  const endRecord = new Uint8Array(22);
  writeUint32(endRecord, 0, ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE);
  writeUint16(endRecord, 4, 0);
  writeUint16(endRecord, 6, 0);
  writeUint16(endRecord, 8, entries.length);
  writeUint16(endRecord, 10, entries.length);
  writeUint32(endRecord, 12, centralDirectory.length);
  writeUint32(endRecord, 16, localData.length);
  writeUint16(endRecord, 20, 0);

  return concatBytes([localData, centralDirectory, endRecord]);
}

describe('parseNpzFile', () => {
  it(
    'reads a large deflated npy entry without stalling',
    async () => {
      const valueCount = 1_000_000;
      const values = new Float64Array(valueCount);
      for (let index = 0; index < values.length; index += 1) {
        values[index] = index % 97;
      }

      const npy = createNpyFloat64Vector(values);
      const npzBytes = await createDeflatedNpz([{ fileName: 'arr.npy', uncompressedData: npy }]);
      const fileBytes = new Uint8Array(npzBytes.byteLength);
      fileBytes.set(npzBytes);
      const file = new File([fileBytes], 'synthetic_large_deflate.npz');

      const archive = await parseNpzFile(file);
      expect(archive.hasFile('arr.npy')).toBe(true);

      const parsed = await archive.readNpy('arr.npy');
      expect(parsed.shape).toEqual([valueCount]);
      expect(parsed.descr).toBe('<f8');

      const decoded = parsed.toNumberArray();
      expect(decoded[0]).toBe(0);
      expect(decoded[1]).toBe(1);
      expect(decoded[97]).toBe(0);
      expect(decoded[valueCount - 1]).toBe((valueCount - 1) % 97);
    },
    20000,
  );
});
