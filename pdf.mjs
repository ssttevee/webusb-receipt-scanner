const haveCompression = typeof CompressionStream !== "undefined";

async function flate(u8, doCompress) {
  if (!doCompress || !haveCompression) {
    return { bytes: u8, filtered: false };
  }
  return {
    bytes: new Uint8Array(
      await new Response(
        new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate")),
      ).arrayBuffer(),
    ),
    filtered: true,
  };
}

export async function create1BitImagePDF(
  images,
  { compressImages = true, compressContents = true } = {},
) {
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error("images must be a non-empty array");
  }

  // Validate inputs first
  images.forEach((img, idx) => {
    if (!(img.data instanceof Uint8Array)) {
      throw new Error(`Image ${idx}: data must be a Uint8Array`);
    }
    if (
      !Number.isInteger(img.width) ||
      img.width <= 0 ||
      !Number.isInteger(img.height) ||
      img.height <= 0
    ) {
      throw new Error(`Image ${idx}: width/height must be positive integers`);
    }
    const rowBytes = Math.ceil(img.width / 8);
    const expected = rowBytes * img.height;
    if (img.data.length !== expected) {
      throw new Error(
        `Image ${idx}: data length mismatch. Expected ${expected}, got ${img.data.length}`,
      );
    }
  });

  const encoder = new TextEncoder();
  const parts = [];
  let length = 0;
  const offsets = [];

  function addBytes(u8) {
    parts.push(u8);
    length += u8.length;
  }
  function addString(str) {
    addBytes(encoder.encode(str));
  }
  function beginObject(num) {
    offsets[num] = length;
    addString(num + " 0 obj\n");
  }
  function endObject() {
    addString("endobj\n");
  }

  // PDF Header
  addString("%PDF-1.4\n");
  addString("%\xE2\xE3\xCF\xD3\n");

  // Object numbering:
  // 1: Catalog
  // 2: Pages (written after page objects)
  // Then per page: (image, content, page) = 3 objects per page
  // Sequence: we will create all page triplets, then the Pages object.
  // Total objects = 2 + 3 * pageCount

  const pageCount = images.length;
  const totalObjects = 2 + pageCount * 3;

  // 1 Catalog (forward reference to Pages object 2)
  beginObject(1);
  addString("<< /Type /Catalog /Pages 2 0 R >>\n");
  endObject();

  const pageObjectNumbers = [];

  // Generate objects for each image/page
  let nextObj = 3;
  for (let i = 0; i < pageCount; i++) {
    const { data, width, height, bottomUp = false, invert = false } = images[i];

    const imageObjNum = nextObj++;
    const contentObjNum = nextObj++;
    const pageObjNum = nextObj++;
    pageObjectNumbers.push(pageObjNum);

    // Prepare image stream (possibly compressed)
    const decodeArray = invert ? "[1 0]" : "[0 1]";

    const imgResult = await flate(data, compressImages);
    beginObject(imageObjNum);
    addString("<< /Type /XObject /Subtype /Image");
    addString(` /Width ${width} /Height ${height}`);
    addString(" /ColorSpace /DeviceGray /BitsPerComponent 1");
    addString(` /Decode ${decodeArray}`);
    if (imgResult.filtered) {
      addString(" /Filter /FlateDecode");
    }
    addString(` /Length ${imgResult.bytes.length} >>\nstream\n`);
    addBytes(imgResult.bytes);
    addString("\nendstream\n");
    endObject();

    // Content stream: place image to fill page.
    const matrix = bottomUp
      ? `${width} 0 0 -${height} 0 ${height} cm`
      : `${width} 0 0 ${height} 0 0 cm`;

    const contentSource = `q\n${matrix}\n/Im0 Do\nQ\n`;
    const contentBytes = encoder.encode(contentSource);
    const contentResult = await flate(contentBytes, compressContents);

    beginObject(contentObjNum);
    addString("<<");
    if (contentResult.filtered) {
      addString(" /Filter /FlateDecode");
    }
    addString(` /Length ${contentResult.bytes.length} >>\nstream\n`);
    addBytes(contentResult.bytes);
    addString("\nendstream\n");
    endObject();

    // Page object referencing its image in Resources and its content stream
    beginObject(pageObjNum);
    addString("<< /Type /Page /Parent 2 0 R");
    addString(` /MediaBox [0 0 ${width} ${height}]`);
    // XObject resource name Im0 is local to the content stream's resource dictionary.
    addString(` /Resources << /XObject << /Im0 ${imageObjNum} 0 R >> >>`);
    addString(` /Contents ${contentObjNum} 0 R >>\n`);
    endObject();
  }

  // 2 Pages object (Kids list)
  beginObject(2);
  addString(`<< /Type /Pages /Count ${pageCount} /Kids [`);
  addString(pageObjectNumbers.map((n) => n + " 0 R").join(" "));
  addString("] >>\n");
  endObject();

  // Cross-reference table
  const xrefOffset = length;
  addString("xref\n");
  addString(`0 ${totalObjects + 1}\n`);
  addString("0000000000 65535 f \n"); // free object
  for (let i = 1; i <= totalObjects; i++) {
    const off = offsets[i];
    const offStr = off.toString().padStart(10, "0");
    addString(`${offStr} 00000 n \n`);
  }

  // Trailer
  addString("trailer\n");
  addString(`<< /Size ${totalObjects + 1} /Root 1 0 R >>\n`);
  addString("startxref\n");
  addString(xrefOffset.toString() + "\n");
  addString("%%EOF");

  // Concatenate into final Uint8Array
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const out = new Uint8Array(totalLen);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}
