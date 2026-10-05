import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  webUtils: {
    getPathForFile: (f: File) => {
      if (f.name === "blob") throw new Error("no path");
      return `/Users/x/${f.name}`;
    },
  },
}));

import { filePath, partitionFiles, pickedFolderRoot } from "../src/ui/file-paths";

const file = (name: string, type = "") => new File(["x"], name, { type });

describe("file-paths", () => {
  it("resolves the disk path via webUtils, empty when it throws", () => {
    expect(filePath(file("doc.pdf"))).toBe("/Users/x/doc.pdf");
    expect(filePath(file("blob"))).toBe("");
  });

  it("splits images from path-backed files and drops path-less ones", () => {
    const img = file("shot.png", "image/png");
    const { images, paths } = partitionFiles([img, file("doc.pdf", "application/pdf"), file("blob")]);
    expect(images).toEqual([img]);
    expect(paths).toEqual(["/Users/x/doc.pdf"]);
  });

  it("derives a picked folder root from the first entry", () => {
    const first = file("file.ts");
    Object.defineProperty(first, "webkitRelativePath", { value: "proj/sub/file.ts" });
    expect(pickedFolderRoot(first, () => "/Users/x/proj/sub/file.ts")).toBe("/Users/x/proj");
    expect(pickedFolderRoot(file("loose.ts"), () => "/a/loose.ts")).toBe("");
  });
});
