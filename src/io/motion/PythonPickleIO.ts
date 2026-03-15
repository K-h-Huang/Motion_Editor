import { Parser } from 'pickleparser';

export interface ParsedPickleNdarrayFloat64 {
  shape: number[];
  values: Float64Array;
}

interface SmplTensorFloat64 extends ParsedPickleNdarrayFloat64 {}

interface SmplTensorInt32 {
  shape: number[];
  values: Int32Array;
}

interface SmplTensorUint32 {
  shape: number[];
  values: Uint32Array;
}

export interface ParsedSmplWebuserPkl {
  vTemplate: SmplTensorFloat64;
  shapedirs: SmplTensorFloat64;
  weights: SmplTensorFloat64;
  kintreeTable: SmplTensorInt32;
  jRegressor: SmplTensorFloat64;
  faces: SmplTensorUint32;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function product(shape: number[]): number {
  let total = 1;
  for (const size of shape) {
    if (!Number.isFinite(size) || size <= 0) {
      return 0;
    }
    total *= size;
  }
  return total;
}

function toFlatInt32(values: Float64Array): Int32Array {
  const output = new Int32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    output[index] = Math.trunc(values[index] ?? 0);
  }
  return output;
}

function toFlatUint32(values: Float64Array): Uint32Array {
  const output = new Uint32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    output[index] = Math.max(0, Math.trunc(values[index] ?? 0));
  }
  return output;
}

function decodeEscapedPythonBody(body: string): string {
  let result = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? '';
    if (char !== '\\') {
      result += char;
      continue;
    }

    const next = body[index + 1] ?? '';
    if (!next) {
      result += '\\';
      break;
    }

    if (next === 'x' && index + 3 < body.length) {
      const hex = body.slice(index + 2, index + 4);
      result += String.fromCharCode(Number.parseInt(hex, 16) || 0);
      index += 3;
      continue;
    }

    if (next >= '0' && next <= '7') {
      let octal = next;
      if (index + 2 < body.length && body[index + 2] >= '0' && body[index + 2] <= '7') {
        octal += body[index + 2];
      }
      if (index + 3 < body.length && body[index + 3] >= '0' && body[index + 3] <= '7') {
        octal += body[index + 3];
      }
      result += String.fromCharCode(Number.parseInt(octal, 8) || 0);
      index += octal.length;
      continue;
    }

    const escaped =
      next === 'n'
        ? '\n'
        : next === 'r'
          ? '\r'
          : next === 't'
            ? '\t'
            : next === 'b'
              ? '\b'
              : next === 'f'
                ? '\f'
                : next === 'v'
                  ? '\v'
                  : next === 'a'
                    ? '\x07'
                    : next;
    result += escaped;
    index += 1;
  }

  return result;
}

function stringToBytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    output[index] = value.charCodeAt(index) & 0xff;
  }
  return output;
}

function normalizeDescriptor(raw: string): string {
  const text = String(raw ?? '').trim();
  if (!text) {
    throw new Error(`Invalid numpy dtype descriptor: ${raw}`);
  }
  if (text[0] === '<' || text[0] === '>' || text[0] === '|' || text[0] === '=') {
    return text;
  }
  return `<${text}`;
}

function parseDescriptor(descriptor: string): {
  typeCode: string;
  width: number;
  littleEndian: boolean;
} {
  const text = normalizeDescriptor(descriptor);
  const typeCode = text[1] ?? '';
  const widthText = text.slice(2);
  const width = Number.parseInt(widthText, 10);
  if (!typeCode || !Number.isFinite(width) || width <= 0) {
    throw new Error(`Unsupported numpy dtype descriptor: ${descriptor}`);
  }
  return {
    typeCode,
    width,
    littleEndian: text[0] !== '>',
  };
}

function convertFortranToCOrder(values: Float64Array, shape: number[]): Float64Array {
  if (shape.length <= 1) {
    return values;
  }

  const rank = shape.length;
  const cStrides = new Array<number>(rank).fill(1);
  const fStrides = new Array<number>(rank).fill(1);
  for (let axis = rank - 2; axis >= 0; axis -= 1) {
    cStrides[axis] = cStrides[axis + 1] * shape[axis + 1];
  }
  for (let axis = 1; axis < rank; axis += 1) {
    fStrides[axis] = fStrides[axis - 1] * shape[axis - 1];
  }

  const output = new Float64Array(values.length);
  const coords = new Array<number>(rank).fill(0);
  for (let linearIndex = 0; linearIndex < values.length; linearIndex += 1) {
    let remainder = linearIndex;
    for (let axis = 0; axis < rank; axis += 1) {
      const stride = cStrides[axis] ?? 1;
      const size = shape[axis] ?? 1;
      coords[axis] = Math.floor(remainder / stride) % size;
      remainder %= stride;
    }

    let fortranIndex = 0;
    for (let axis = 0; axis < rank; axis += 1) {
      fortranIndex += (coords[axis] ?? 0) * (fStrides[axis] ?? 1);
    }
    output[linearIndex] = values[fortranIndex] ?? 0;
  }

  return output;
}

function decodeNdarrayValues(
  rawBytes: Uint8Array,
  descriptor: string,
  shape: number[],
  fortranOrder: boolean,
): Float64Array {
  const totalElements = product(shape);
  if (totalElements <= 0) {
    throw new Error(`Invalid numpy ndarray shape: [${shape.join(', ')}]`);
  }

  const parsed = parseDescriptor(descriptor);
  const expectedBytes = totalElements * parsed.width;
  if (rawBytes.length < expectedBytes) {
    throw new Error(
      `Invalid ndarray payload length. Expected ${expectedBytes}, got ${rawBytes.length}.`,
    );
  }

  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, expectedBytes);
  const values = new Float64Array(totalElements);
  for (let index = 0; index < totalElements; index += 1) {
    const offset = index * parsed.width;
    if (parsed.typeCode === 'f' && parsed.width === 8) {
      values[index] = view.getFloat64(offset, parsed.littleEndian);
      continue;
    }
    if (parsed.typeCode === 'f' && parsed.width === 4) {
      values[index] = view.getFloat32(offset, parsed.littleEndian);
      continue;
    }
    if (parsed.typeCode === 'i' && parsed.width === 1) {
      values[index] = view.getInt8(offset);
      continue;
    }
    if (parsed.typeCode === 'i' && parsed.width === 2) {
      values[index] = view.getInt16(offset, parsed.littleEndian);
      continue;
    }
    if (parsed.typeCode === 'i' && parsed.width === 4) {
      values[index] = view.getInt32(offset, parsed.littleEndian);
      continue;
    }
    if (parsed.typeCode === 'u' && parsed.width === 1) {
      values[index] = view.getUint8(offset);
      continue;
    }
    if (parsed.typeCode === 'u' && parsed.width === 2) {
      values[index] = view.getUint16(offset, parsed.littleEndian);
      continue;
    }
    if (parsed.typeCode === 'u' && parsed.width === 4) {
      values[index] = view.getUint32(offset, parsed.littleEndian);
      continue;
    }
    if (parsed.typeCode === 'b' && parsed.width === 1) {
      values[index] = view.getUint8(offset) !== 0 ? 1 : 0;
      continue;
    }

    throw new Error(`Unsupported ndarray dtype descriptor: ${descriptor}`);
  }

  if (fortranOrder) {
    return convertFortranToCOrder(values, shape);
  }

  return values;
}

export function parsePythonPickleBuffer(buffer: ArrayBuffer): unknown {
  const parser = new Parser({
    unpicklingTypeOfSet: 'array',
    unpicklingTypeOfDictionary: 'object',
  });
  return parser.parse(new Uint8Array(buffer));
}

function extractDescriptorFromPickleparserDtype(value: unknown): string {
  if (typeof value === 'string') {
    return normalizeDescriptor(value);
  }

  if (!isRecord(value)) {
    throw new Error('Unsupported pickleparser dtype payload.');
  }

  if (typeof value.descriptor === 'string') {
    return normalizeDescriptor(value.descriptor);
  }

  const args = (value as { args?: unknown }).args;
  if (Array.isArray(args) && typeof args[0] === 'string') {
    return normalizeDescriptor(args[0]);
  }

  if (typeof value['0'] === 'string') {
    return normalizeDescriptor(String(value['0']));
  }

  throw new Error('Unsupported pickleparser dtype payload.');
}

function toRawBytesFromPickleparser(value: unknown): Uint8Array {
  if (typeof value === 'string') {
    return stringToBytes(decodeEscapedPythonBody(value));
  }

  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof Int8Array || value instanceof Uint8ClampedArray) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }

  if (Array.isArray(value)) {
    const output = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      output[index] = Math.trunc(Number(value[index] ?? 0)) & 0xff;
    }
    return output;
  }

  throw new Error('Unsupported pickleparser ndarray raw data payload.');
}

function parseNdarrayFromPickleparser(value: unknown, label: string): SmplTensorFloat64 {
  if (!isRecord(value)) {
    throw new Error(`${label} is not a numpy ndarray in Python pickle.`);
  }

  const shapeRaw = value['1'];
  const dtypeRaw = value['2'];
  const fortranRaw = value['3'];
  const dataRaw = value['4'];

  if (!Array.isArray(shapeRaw) || dtypeRaw === undefined || dataRaw === undefined) {
    throw new Error(`${label} is not a numpy ndarray in Python pickle.`);
  }

  const shape = shapeRaw.map((entry) => Math.trunc(Number(entry ?? 0)));
  if (shape.length === 0 || shape.some((entry) => !Number.isFinite(entry) || entry <= 0)) {
    throw new Error(`Invalid ndarray shape from pickleparser payload for ${label}.`);
  }

  const descriptor = extractDescriptorFromPickleparserDtype(dtypeRaw);
  const rawBytes = toRawBytesFromPickleparser(dataRaw);
  const fortranOrder = Boolean(fortranRaw);

  return {
    shape,
    values: decodeNdarrayValues(rawBytes, descriptor, shape, fortranOrder),
  };
}

export function parsePickleNdarrayFloat64(
  value: unknown,
  label: string,
): ParsedPickleNdarrayFloat64 {
  return parseNdarrayFromPickleparser(value, label);
}

function toFloatTensor(value: unknown, label: string): SmplTensorFloat64 {
  return parseNdarrayFromPickleparser(value, label);
}

function toFloatTensorFromChumpy(value: unknown, label: string): SmplTensorFloat64 {
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, 'x')) {
    return parseNdarrayFromPickleparser(value.x, `${label}.x`);
  }
  return parseNdarrayFromPickleparser(value, label);
}

function toDenseRegressor(value: unknown): SmplTensorFloat64 {
  if (!isRecord(value)) {
    throw new Error('SMPL PKL J_regressor is not supported.');
  }

  if (
    Object.prototype.hasOwnProperty.call(value, '_shape') &&
    Object.prototype.hasOwnProperty.call(value, 'data') &&
    Object.prototype.hasOwnProperty.call(value, 'indices') &&
    Object.prototype.hasOwnProperty.call(value, 'indptr')
  ) {
    const shapeRaw = value._shape;
    if (!Array.isArray(shapeRaw) || shapeRaw.length !== 2) {
      throw new Error('SMPL PKL sparse J_regressor payload is invalid.');
    }

    const rows = Math.trunc(Number(shapeRaw[0] ?? 0));
    const cols = Math.trunc(Number(shapeRaw[1] ?? 0));
    if (rows <= 0 || cols <= 0) {
      throw new Error('SMPL PKL sparse J_regressor shape is invalid.');
    }

    const dataTensor = parseNdarrayFromPickleparser(value.data, 'J_regressor.data');
    const indicesTensor = parseNdarrayFromPickleparser(value.indices, 'J_regressor.indices');
    const indptrTensor = parseNdarrayFromPickleparser(value.indptr, 'J_regressor.indptr');

    const data = dataTensor.values;
    const indices = toFlatInt32(indicesTensor.values);
    const indptr = toFlatInt32(indptrTensor.values);

    if (indptr.length < cols + 1) {
      throw new Error('SMPL PKL sparse J_regressor indptr length is invalid.');
    }

    const dense = new Float64Array(rows * cols);
    for (let col = 0; col < cols; col += 1) {
      const start = indptr[col] ?? 0;
      const end = indptr[col + 1] ?? 0;
      for (let entry = start; entry < end; entry += 1) {
        const row = indices[entry] ?? 0;
        if (row < 0 || row >= rows) {
          continue;
        }
        dense[row * cols + col] = data[entry] ?? 0;
      }
    }

    return {
      shape: [rows, cols],
      values: dense,
    };
  }

  return parseNdarrayFromPickleparser(value, 'J_regressor');
}

function toIntTensor(value: unknown, label: string): SmplTensorInt32 {
  const tensor = toFloatTensor(value, label);
  return {
    shape: tensor.shape,
    values: toFlatInt32(tensor.values),
  };
}

function toUintTensor(value: unknown, label: string): SmplTensorUint32 {
  const tensor = toFloatTensor(value, label);
  return {
    shape: tensor.shape,
    values: toFlatUint32(tensor.values),
  };
}

export async function parseSmplWebuserPkl(file: File): Promise<ParsedSmplWebuserPkl> {
  const buffer = await file.arrayBuffer();
  let parsed: unknown;
  try {
    parsed = parsePythonPickleBuffer(buffer);
  } catch (error) {
    throw new Error(`Failed to parse SMPL PKL with pickleparser: ${toErrorMessage(error)}.`);
  }

  if (!isRecord(parsed)) {
    throw new Error('SMPL PKL root object must be a dictionary.');
  }

  return {
    vTemplate: toFloatTensor(parsed.v_template, 'v_template'),
    shapedirs: toFloatTensorFromChumpy(parsed.shapedirs, 'shapedirs'),
    weights: toFloatTensor(parsed.weights, 'weights'),
    kintreeTable: toIntTensor(parsed.kintree_table, 'kintree_table'),
    jRegressor: toDenseRegressor(parsed.J_regressor),
    faces: toUintTensor(parsed.f, 'f'),
  };
}
