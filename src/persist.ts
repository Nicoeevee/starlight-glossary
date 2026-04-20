import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Atomic JSON write: stringify to a sibling `.tmp` file, then rename over
// the target. Rename is atomic on POSIX filesystems, so a crash or OOM kill
// mid-write can't corrupt the original. A parallel reader either sees the
// old file or the new one — never a half-written byte stream.

export async function writeJsonAtomic(
  path: string,
  data: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(data, null, 2) + "\n";
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}
