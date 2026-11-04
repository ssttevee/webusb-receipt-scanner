// Dependency-free helpers shared by the sample utility and its checks.
export function receiptDimensions(widthMm, lengthMm, dpi) {
  if (![widthMm, lengthMm, dpi].every(Number.isFinite) ||
      widthMm < 40 || widthMm > 216 || lengthMm < 50 || lengthMm > 1200 ||
      ![150, 200, 300, 600].includes(dpi)) {
    throw new Error("Use width 40–216 mm, length 50–1,200 mm, and 150/200/300/600 DPI.");
  }
  const width = Math.round(widthMm * dpi / 25.4);
  const height = Math.round(lengthMm * dpi / 25.4);
  if (height > 16000 || width * height > 20000000) {
    throw new Error("This fixture generator is limited to 20 MP and 16,000 rows. Use 300 DPI for metre-long fixtures.");
  }
  return { width, height };
}

export function seededRandom(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

export function validateLabels(date, time) {
  if (date) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) throw new Error("Expected date must be YYYY-MM-DD or blank.");
    const [year, month, day] = match.slice(1).map(Number);
    const parsed = new Date(0);
    parsed.setUTCFullYear(year, month - 1, day);
    if (year < 1 || parsed.getUTCFullYear() !== year ||
        parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
      throw new Error("Expected date is not a valid calendar date.");
    }
  }
  if (time && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(time)) {
    throw new Error("Expected time must be HH:MM or HH:MM:SS (24-hour), or blank.");
  }
}

export function printedDate(date, format) {
  if (!date) return "DATE NOT PRINTED";
  const [year, month, day] = date.split("-");
  switch (format) {
    case "dmy": return `${day}/${month}/${year}`;
    case "mdy": return `${month}/${day}/${year}`;
    case "named": return `${day} ${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(month) - 1]} ${year}`;
    default: return date;
  }
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Stored ZIP entries avoid recompressing PNG/TIFF data. Blob parts avoid a
// second contiguous copy of the entire archive. Names are internal, not input paths.
export function sampleZip(entries) {
  if (entries.length > 65535) throw new Error("Too many ZIP entries.");
  const encoder = new TextEncoder();
  const parts = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const { name, bytes } of entries) {
    if (!/^[a-zA-Z0-9_.-]+$/.test(name) || !(bytes instanceof Uint8Array)) {
      throw new Error("Invalid sample archive entry.");
    }
    const filename = encoder.encode(name);
    const checksum = crc32(bytes);
    const local = new Uint8Array(30 + filename.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(12, 33, true); // 1980-01-01
    lv.setUint32(14, checksum, true);
    lv.setUint32(18, bytes.length, true);
    lv.setUint32(22, bytes.length, true);
    lv.setUint16(26, filename.length, true);
    local.set(filename, 30);
    const central = new Uint8Array(46 + filename.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(14, 33, true);
    cv.setUint32(16, checksum, true);
    cv.setUint32(20, bytes.length, true);
    cv.setUint32(24, bytes.length, true);
    cv.setUint16(28, filename.length, true);
    cv.setUint32(42, offset, true);
    central.set(filename, 46);
    parts.push(local, bytes);
    directory.push(central);
    offset += local.length + bytes.length;
    directorySize += central.length;
  }
  if (offset + directorySize > 0xffffffff) throw new Error("Sample archive exceeds ZIP32 limits.");
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directorySize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end], { type: "application/zip" });
}
