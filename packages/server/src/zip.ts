import zlib from "node:zlib";

/**
 * Reading a zip, in the one case this app needs it.
 *
 * LinkedIn emails a career history as a zip of CSVs, and the alternative to
 * reading it was telling the person to unzip it first. That instruction is
 * small and it is also exactly the sort of step at which somebody stops —
 * which matters more than usual here, because this route exists instead of
 * reading their LinkedIn page for them. A route chosen on principle has to be
 * no more work than the one it replaced.
 *
 * Written out rather than taken from a package. A zip's central directory is
 * sixty lines of offsets and node has the only hard part — inflate — built in,
 * so a dependency would be carrying a general-purpose archive reader, and its
 * updates, to open one email attachment.
 *
 * It reads what LinkedIn sends: stored and deflated entries, no encryption, no
 * zip64, no spanning. Anything else is refused by name rather than guessed at.
 */

const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const END = 0x06054b50;

export interface Entry {
  name: string;
  size: number;
}

/*
  The end record is at the end, unless there is a comment after it — so it is
  found by scanning backwards for the signature rather than by arithmetic. The
  comment can be 64KB, which is as far back as it is worth looking.
*/
function endAt(buffer: Buffer): number {
  const from = Math.max(0, buffer.length - 65_557);
  for (let at = buffer.length - 22; at >= from; at -= 1) {
    if (buffer.readUInt32LE(at) === END) return at;
  }
  throw new Error("Not a zip file, or the end of it is missing.");
}

/** What is in the archive, without decompressing any of it. */
export function list(buffer: Buffer): Entry[] {
  const end = endAt(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);

  if (at === 0xffffffff || count === 0xffff) {
    throw new Error("This is a zip64 archive, which this app does not read. Unzip it yourself.");
  }

  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) {
      throw new Error("The zip's index is damaged.");
    }
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    entries.push({
      name: buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
      size: buffer.readUInt32LE(at + 24),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/*
  Where each entry's bytes are, read from the central directory rather than by
  walking the local headers: a local header's sizes may be zeroed and written
  afterwards in a data descriptor, and the directory's copy is the reliable one.
*/
interface Placed {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
  flags: number;
}

function placed(buffer: Buffer): Placed[] {
  const end = endAt(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);

  const found: Placed[] = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(at) !== CENTRAL) throw new Error("The zip's index is damaged.");
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    found.push({
      flags: buffer.readUInt16LE(at + 8),
      method: buffer.readUInt16LE(at + 10),
      compressed: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      offset: buffer.readUInt32LE(at + 42),
      name: buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8"),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return found;
}

/**
 * The text of the entries a caller wants.
 *
 * `wanted` decides which, by name, so an archive of two hundred files is read
 * for the five that say anything about a career. A member is skipped rather
 * than fatal when it is compressed in a way this cannot read: five of six
 * files is a better import than an error.
 *
 * `most` caps what is decompressed. A zip says how large an entry expands to
 * and can say anything it likes, so the limit is applied to the claim as well
 * as to the result.
 */
export function readText(
  buffer: Buffer,
  wanted: (name: string) => boolean,
  most = 2_000_000,
): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  let budget = most;

  for (const entry of placed(buffer)) {
    if (entry.name.endsWith("/") || !wanted(entry.name)) continue;
    if ((entry.flags & 0x1) !== 0) continue; // encrypted
    if (entry.size > budget) continue;

    const head = entry.offset;
    if (buffer.readUInt32LE(head) !== LOCAL) continue;
    const nameLength = buffer.readUInt16LE(head + 26);
    const extraLength = buffer.readUInt16LE(head + 28);
    const from = head + 30 + nameLength + extraLength;
    const bytes = buffer.subarray(from, from + entry.compressed);

    let text: string;
    try {
      if (entry.method === 0) text = bytes.toString("utf8");
      else if (entry.method === 8) text = zlib.inflateRawSync(bytes).toString("utf8");
      else continue;
    } catch {
      continue; // One unreadable member is not an unreadable archive.
    }

    budget -= Buffer.byteLength(text);
    if (budget < 0) break;
    out.push({ name: entry.name, text });
  }

  return out;
}

/** Whether these bytes look like a zip at all, before anything is attempted. */
export function isZip(buffer: Buffer): boolean {
  if (buffer.length < 22) return false;
  const start = buffer.readUInt32LE(0);
  if (start === LOCAL || start === CENTRAL || start === END) return true;
  try {
    return buffer.readUInt32LE(endAt(buffer)) === END;
  } catch {
    return false;
  }
}
