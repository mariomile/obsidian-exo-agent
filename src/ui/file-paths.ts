import { webUtils } from "electron";

/** Absolute disk path of a File, "" for in-memory blobs (e.g. pasted screenshots).
 *  Electron 32+ dropped `File.path`; `webUtils.getPathForFile` replaces it. */
export function filePath(f: File): string {
  try {
    return webUtils.getPathForFile(f);
  } catch {
    return "";
  }
}

/** Split dropped/pasted files: images become inline attachments, any other file
 *  with a disk path (Finder drag/copy) becomes an external context path. */
export function partitionFiles(files: File[], pathOf = filePath): { images: File[]; paths: string[] } {
  const images: File[] = [];
  const paths: string[] = [];
  for (const f of files) {
    if (f.type.startsWith("image/")) images.push(f);
    else {
      const p = pathOf(f);
      if (p) paths.push(p);
    }
  }
  return { images, paths };
}

/** Root of a folder picked via webkitdirectory, from its first entry:
 *  abs /Users/x/proj/sub/file.ts + rel proj/sub/file.ts → /Users/x/proj. */
export function pickedFolderRoot(first: File, pathOf = filePath): string {
  const abs = pathOf(first);
  const rel = first.webkitRelativePath;
  if (!abs || !rel) return "";
  return abs.slice(0, abs.length - rel.length) + rel.split("/")[0];
}
