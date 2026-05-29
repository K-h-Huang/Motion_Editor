export interface Float64MatrixPayload {
  rows: number;
  cols: number;
  values: ArrayLike<number>;
}

export interface GmrPythonPicklePayload {
  fps: number;
  rootPos: Float64MatrixPayload;
  rootRot: Float64MatrixPayload;
  dofPos: Float64MatrixPayload;
  linkBodyList: string[] | null;
}

class PickleProtocol2Writer {
  private readonly bytes: number[] = [];

  finish(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }

  writeProtocolHeader(): void {
    this.pushByte(0x80);
    this.pushByte(0x02);
  }

  writeStop(): void {
    this.pushAscii('.');
  }

  writeMark(): void {
    this.pushAscii('(');
  }

  writeTuple(): void {
    this.pushAscii('t');
  }

  writeTuple1(): void {
    this.pushByte(0x85);
  }

  writeTuple2(): void {
    this.pushByte(0x86);
  }

  writeTuple3(): void {
    this.pushByte(0x87);
  }

  writeReduce(): void {
    this.pushAscii('R');
  }

  writeBuild(): void {
    this.pushAscii('b');
  }

  writeNone(): void {
    this.pushAscii('N');
  }

  writeSetItem(): void {
    this.pushAscii('s');
  }

  writeEmptyDict(): void {
    this.pushAscii('}');
  }

  writeEmptyList(): void {
    this.pushAscii(']');
  }

  writeAppend(): void {
    this.pushAscii('a');
  }

  writeGlobal(moduleName: string, symbolName: string): void {
    this.pushAscii(`c${moduleName}\n${symbolName}\n`);
  }

  writeBoolean(value: boolean): void {
    this.pushByte(value ? 0x88 : 0x89);
  }

  writeInt(value: number): void {
    const integerValue = Math.trunc(value);
    if (integerValue >= 0 && integerValue <= 0xff) {
      this.pushAscii('K');
      this.pushByte(integerValue);
      return;
    }

    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setInt32(0, integerValue, true);
    this.pushAscii('J');
    this.pushBytes(new Uint8Array(buffer));
  }

  writeFloat(value: number): void {
    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    view.setFloat64(0, value, false);
    this.pushAscii('G');
    this.pushBytes(new Uint8Array(buffer));
  }

  writeUnicode(text: string): void {
    const encoded = new TextEncoder().encode(text);
    this.pushAscii('X');
    this.pushUint32(encoded.length);
    this.pushBytes(encoded);
  }

  private pushUint32(value: number): void {
    this.pushByte(value & 0xff);
    this.pushByte((value >>> 8) & 0xff);
    this.pushByte((value >>> 16) & 0xff);
    this.pushByte((value >>> 24) & 0xff);
  }

  private pushAscii(text: string): void {
    for (let index = 0; index < text.length; index += 1) {
      this.pushByte(text.charCodeAt(index) & 0xff);
    }
  }

  private pushBytes(bytes: ArrayLike<number>): void {
    for (let index = 0; index < bytes.length; index += 1) {
      this.pushByte(bytes[index] ?? 0);
    }
  }

  private pushByte(value: number): void {
    this.bytes.push(value & 0xff);
  }
}

function encodeRawBytesAsLatin1Unicode(rawBytes: Uint8Array): string {
  let output = '';
  const chunkSize = 0x4000;
  for (let offset = 0; offset < rawBytes.length; offset += chunkSize) {
    const end = Math.min(offset + chunkSize, rawBytes.length);
    let chunk = '';
    for (let index = offset; index < end; index += 1) {
      chunk += String.fromCharCode(rawBytes[index] ?? 0);
    }
    output += chunk;
  }
  return output;
}

function encodeMatrixValuesAsFloat64Bytes(matrix: Float64MatrixPayload): Uint8Array {
  const expectedLength = matrix.rows * matrix.cols;
  if (!Number.isInteger(matrix.rows) || matrix.rows <= 0) {
    throw new Error(`Invalid matrix row count: ${matrix.rows}.`);
  }
  if (!Number.isInteger(matrix.cols) || matrix.cols <= 0) {
    throw new Error(`Invalid matrix column count: ${matrix.cols}.`);
  }
  if (matrix.values.length !== expectedLength) {
    throw new Error(
      `Matrix value length mismatch. Expected ${expectedLength}, received ${matrix.values.length}.`,
    );
  }

  const buffer = new ArrayBuffer(expectedLength * 8);
  const view = new DataView(buffer);
  for (let index = 0; index < expectedLength; index += 1) {
    view.setFloat64(index * 8, Number(matrix.values[index] ?? 0), true);
  }
  return new Uint8Array(buffer);
}

function writePython2Bytes(writer: PickleProtocol2Writer, rawBytes: Uint8Array): void {
  writer.writeGlobal('_codecs', 'encode');
  writer.writeUnicode(encodeRawBytesAsLatin1Unicode(rawBytes));
  writer.writeUnicode('latin1');
  writer.writeTuple2();
  writer.writeReduce();
}

function writeShapeTuple(writer: PickleProtocol2Writer, shape: readonly number[]): void {
  writer.writeMark();
  for (const size of shape) {
    writer.writeInt(size);
  }
  writer.writeTuple();
}

function writeFloat64Ndarray(writer: PickleProtocol2Writer, matrix: Float64MatrixPayload): void {
  const rawBytes = encodeMatrixValuesAsFloat64Bytes(matrix);

  writer.writeGlobal('numpy.core.multiarray', '_reconstruct');
  writer.writeGlobal('numpy', 'ndarray');
  writer.writeInt(0);
  writer.writeTuple1();
  writePython2Bytes(writer, Uint8Array.of(0x62));
  writer.writeTuple3();
  writer.writeReduce();

  writer.writeMark();
  writer.writeInt(1);
  writeShapeTuple(writer, [matrix.rows, matrix.cols]);

  writer.writeGlobal('numpy', 'dtype');
  writer.writeUnicode('f8');
  writer.writeBoolean(false);
  writer.writeBoolean(true);
  writer.writeTuple3();
  writer.writeReduce();

  writer.writeMark();
  writer.writeInt(3);
  writer.writeUnicode('<');
  writer.writeNone();
  writer.writeNone();
  writer.writeNone();
  writer.writeInt(-1);
  writer.writeInt(-1);
  writer.writeInt(0);
  writer.writeTuple();
  writer.writeBuild();

  writer.writeBoolean(false);
  writePython2Bytes(writer, rawBytes);
  writer.writeTuple();
  writer.writeBuild();
}

function writeStringList(writer: PickleProtocol2Writer, values: readonly string[]): void {
  writer.writeEmptyList();
  for (const value of values) {
    writer.writeUnicode(value);
    writer.writeAppend();
  }
}

export function dumpGmrMotionPythonPickle(payload: GmrPythonPicklePayload): Uint8Array {
  const writer = new PickleProtocol2Writer();
  writer.writeProtocolHeader();
  writer.writeEmptyDict();

  writer.writeUnicode('fps');
  writer.writeFloat(payload.fps);
  writer.writeSetItem();

  writer.writeUnicode('root_pos');
  writeFloat64Ndarray(writer, payload.rootPos);
  writer.writeSetItem();

  writer.writeUnicode('root_rot');
  writeFloat64Ndarray(writer, payload.rootRot);
  writer.writeSetItem();

  writer.writeUnicode('dof_pos');
  writeFloat64Ndarray(writer, payload.dofPos);
  writer.writeSetItem();

  writer.writeUnicode('local_body_pos');
  writer.writeNone();
  writer.writeSetItem();

  writer.writeUnicode('link_body_list');
  if (payload.linkBodyList === null) {
    writer.writeNone();
  } else {
    writeStringList(writer, payload.linkBodyList);
  }
  writer.writeSetItem();

  writer.writeStop();
  return writer.finish();
}
