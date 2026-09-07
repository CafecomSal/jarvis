import { isAbsolute, relative, resolve, sep } from 'node:path';

export function resolveRecordingFile(rootDirectory: string, fileRef: string): string {
  const root = resolve(rootDirectory);
  const normalizedRef = fileRef.replaceAll('\\', '/');
  if (!normalizedRef.trim()) throw new Error('Recording file reference must not be empty');
  const filePath = resolve(root, ...normalizedRef.split('/'));
  const relativePath = relative(root, filePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath) || relativePath.split(sep).includes('..')) {
    throw new Error('Recording file reference escapes archive root');
  }
  return filePath;
}
