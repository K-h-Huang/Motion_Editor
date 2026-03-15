import type { DroppedFileMap } from '../../types/viewer';
import { normalizePath } from '../urdf/pathResolver';

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  fullPath: string;
  name: string;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  file: (successCallback: (file: File) => void, errorCallback?: (error: DOMException) => void) => void;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (
    successCallback: (entries: FileSystemEntryLike[]) => void,
    errorCallback?: (error: DOMException) => void,
  ) => void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  createReader: () => FileSystemDirectoryReaderLike;
}

function isFileEntry(entry: FileSystemEntryLike): entry is FileSystemFileEntryLike {
  return entry.isFile;
}

function isDirectoryEntry(entry: FileSystemEntryLike): entry is FileSystemDirectoryEntryLike {
  return entry.isDirectory;
}

function storeFile(fileMap: DroppedFileMap, file: File, rawPath: string): void {
  const normalizedPath = normalizePath(rawPath || file.webkitRelativePath || file.name);
  if (!normalizedPath) {
    return;
  }

  fileMap.set(normalizedPath, file);
}

function readFileFromEntry(fileEntry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    fileEntry.file(resolve, reject);
  });
}

function readDirectoryBatch(reader: FileSystemDirectoryReaderLike): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function collectEntry(entry: FileSystemEntryLike, fileMap: DroppedFileMap): Promise<void> {
  if (isFileEntry(entry)) {
    const file = await readFileFromEntry(entry);
    const path = entry.fullPath || file.webkitRelativePath || file.name;
    storeFile(fileMap, file, path);
    return;
  }

  if (!isDirectoryEntry(entry)) {
    return;
  }

  const reader = entry.createReader();
  while (true) {
    const batch = await readDirectoryBatch(reader);
    if (batch.length === 0) {
      break;
    }

    for (const childEntry of batch) {
      await collectEntry(childEntry, fileMap);
    }
  }
}

export function fileListToFileMap(files: Iterable<File>): DroppedFileMap {
  const fileMap: DroppedFileMap = new Map();

  for (const file of files) {
    const rawPath = file.webkitRelativePath || file.name;
    storeFile(fileMap, file, rawPath);
  }

  return fileMap;
}

export async function dataTransferToFileMap(dataTransfer: DataTransfer): Promise<DroppedFileMap> {
  const fileMap: DroppedFileMap = new Map();
  const items = Array.from(dataTransfer.items ?? []);

  const hasEntryAPI = items.some((item) => {
    const maybeItem = item as DataTransferItemWithEntry;
    return typeof maybeItem.webkitGetAsEntry === 'function';
  });

  if (hasEntryAPI) {
    for (const item of items) {
      const maybeItem = item as DataTransferItemWithEntry;
      const entry = maybeItem.webkitGetAsEntry?.();
      if (!entry) {
        continue;
      }

      await collectEntry(entry, fileMap);
    }
  }

  if (fileMap.size > 0) {
    return fileMap;
  }

  return fileListToFileMap(Array.from(dataTransfer.files ?? []));
}
