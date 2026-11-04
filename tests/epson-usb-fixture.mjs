// Simulated RR-70W USB/eSCI-2 transport for exercising the compiled C backend.
// No real USB permission or physical scanner is used by this fixture.
export function installEpsonFixture() {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("latin1");
  const replies = [];
  let parameterLength = 0;
  let width = 1696;
  let height = 4000;
  let dpi = 200;
  let depth = 1;
  let channels = 1;
  let imageOffset = 0;
  const commands = [];
  const control = { commands, paperAvailable: true, missingRow: false, emitLft: true, emptyPadding: 2, busyPolls: 0, statusFault: null };
  const config = { configurationValue: 1 };
  const bytes = (data) => data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const header = (command, payloadLength, metadata = "#---") => {
    const output = new Uint8Array(64);
    output.set(encoder.encode(`${command}x${payloadLength.toString(16).padStart(7, "0")}${metadata}`));
    replies.push(output);
  };
  const response = (command, body = "") => {
    const data = encoder.encode(body);
    header(command, data.length);
    if (data.length) replies.push(data);
  };
  const device = {
    vendorId: 0x04b8, productId: 0x018b, manufacturerName: "EPSON", productName: "RR-70W", serialNumber: "fixture",
    opened: false, configuration: config,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    async selectConfiguration() { this.configuration = config; },
    async claimInterface() {}, async releaseInterface() {}, async selectAlternateInterface() {}, async clearHalt() {}, async reset() { replies.length = 0; },
    async controlTransferOut(_setup, data) { return { status: "ok", bytesWritten: data?.byteLength || 0 }; },
    async controlTransferIn(setup) {
      let data;
      if ((setup.value >> 8) === 1) {
        data = Uint8Array.of(18,1,0,2,0,0,0,64,184,4,139,1,0,1,1,2,3,1);
      } else if ((setup.value >> 8) === 2) {
        data = Uint8Array.of(9,2,32,0,1,1,0,128,50,9,4,0,0,2,255,0,0,0,7,5,1,2,0,2,0,7,5,130,2,0,2,0);
      } else {
        const text = ["", "EPSON", "RR-70W", "fixture"][setup.value & 255] || "";
        data = new Uint8Array(2 + text.length * 2);
        data[0] = data.length; data[1] = 3;
        for (let i = 0; i < text.length; i++) data[2 + i * 2] = text.charCodeAt(i);
      }
      return { status: "ok", data: new DataView(data.buffer) };
    },
    async transferOut(_endpoint, payload) {
      const data = bytes(payload);
      if (parameterLength) {
        const text = decoder.decode(data);
        commands.push({ command: "PARA", payload: text.slice(0, text.indexOf("#GMT") >= 0 ? text.indexOf("#GMT") : text.length) });
        const area = /#ACQi(\d{7})i(\d{7})i(\d{7})i(\d{7})/.exec(text);
        if (area) { width = Number(area[3]); height = Number(area[4]); }
        const resolution = /#RSMd(\d{3})/.exec(text);
        if (resolution) dpi = Number(resolution[1]);
        const color = /#COL([MC])(\d{3})/.exec(text);
        if (color) { channels = color[1] === "C" ? 3 : 1; depth = Number(color[2]) / channels; }
        parameterLength = 0;
        header("PARA", 0, "#parOK  #---");
      } else if (data.length === 2 && data[0] === 28 && data[1] === 88) {
        replies.push(Uint8Array.of(6));
      } else {
        const text = decoder.decode(data);
        const command = text.slice(0, 4);
        const length = parseInt(text.slice(5, 12), 16) || 0;
        commands.push({ command });
        if (command === "INFO") {
          response(command, "#PRDh006RR-70W#ADFTYPEFEED#ADFAREAi0000850i0002000#ADFAMAXi0000850i0007200#ADFALGNLEFT#---");
        } else if (command === "CAPA") {
          response(command, "#ADFPEDT#COLLISTM001M008C024#RSMLISTi0000200i0000300#FMTJPG RAW #---");
        } else if (command === "PARA" && length) {
          parameterLength = length;
        } else if (command === "STAT") {
          if (control.busyPolls > 0) { control.busyPolls--; header(command, 0, "#nrdBUSY#---"); }
          else if (control.statusFault) header(command, 0, `#ERRADF ${control.statusFault.padEnd(4, " ")}#---`);
          else header(command, 0, control.paperAvailable ? "#---" : `#ERRADF PE${" ".repeat(control.emptyPadding)}#---`);
        } else if (command === "TRDT") {
          imageOffset = 0;
          header(command, 0);
        } else if (command === "IMG ") {
          const actualHeight = Math.round(1000 * dpi / 25.4);
          const stride = Math.ceil(width * channels * depth / 8);
          const total = stride * (actualHeight - (control.missingRow ? 1 : 0));
          if (!control.paperAvailable || height < actualHeight) {
            header(command, 0, "#errADF PJ  #---");
          } else if (imageOffset < total) {
            const size = Math.min(262144, total - imageOffset);
            header(command, size, imageOffset === 0 ? `#psti${String(width).padStart(7, "0")}i0000000i${String(actualHeight).padStart(7, "0")}#---` : "#---");
            replies.push(new Uint8Array(size).fill(170));
            imageOffset += size;
          } else {
            header(command, 0, `#peni${String(width).padStart(7, "0")}i${String(actualHeight).padStart(7, "0")}${control.emitLft ? "#lftd000" : ""}#---`);
            control.paperAvailable = false;
          }
        } else {
          header(command, 0);
        }
      }
      return { status: "ok", bytesWritten: data.length };
    },
    async transferIn(_endpoint, length) {
      const data = replies.shift();
      if (!data) throw new Error(`Fixture has no reply queued for ${length} bytes`);
      if (data.length > length) replies.unshift(data.subarray(length));
      const part = data.subarray(0, length);
      return { status: "ok", data: new DataView(part.buffer, part.byteOffset, part.byteLength) };
    },
  };
  Object.defineProperty(navigator, "usb", { value: { getDevices: async () => [device], requestDevice: async () => device } });
  globalThis.epsonFixture = control;
}
