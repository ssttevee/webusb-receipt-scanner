import loadsane, {
  SANEFrame,
  SANEStatus,
} from "https://esm.sh/sane-wasm@0.5.0";

const sane = await loadsane({
  sane: {
    loaderURL: "/build",
  },
});

const { status } = sane.sane_init();
if (status !== SANEStatus.GOOD) {
  throw new Error(`Failed to initialize sane: ${sane.sane_strstatus(status)}`);
}

// automatically open the first device if previously connected
const { devices } = await sane.sane_get_devices();
if (devices?.length) {
  for (const device of devices) {
    const { status } = await sane.sane_open(device.name);
    if (status === SANEStatus.GOOD) {
      console.log(`Connected to ${device.name}`, device);
      break;
    }
  }
}

const globalAbortController = new AbortController();
window.addEventListener("beforeunload", () => {
  const { open } = sane.sane_get_state();
  if (!open) {
    return;
  }

  globalAbortController.abort("Exiting");

  sane.sane_close();
});

export function connected() {
  return sane.sane_get_state().open;
}

export async function connect() {
  const { open } = sane.sane_get_state();
  if (open) {
    return;
  }

  await navigator.usb.requestDevice({
    filters: [],
  });

  const { devices } = await sane.sane_get_devices();
  if (devices?.length) {
    for (const device of devices) {
      const { status } = await sane.sane_open(device.name);
      if (status !== SANEStatus.GOOD) {
        throw new Error(`Failed to start scan: ${sane.sane_strstatus(status)}`);
      }
    }
  } else {
    throw new Error("No scanner found");
  }
}

async function* scanLoop(abortSignal) {
  const { open } = sane.sane_get_state();
  if (!open) {
    throw new Error("Scanner not connected");
  }

  const actualAbortSignal = AbortSignal.any([
    globalAbortController.signal,
    ...(abortSignal ? [abortSignal] : []),
  ]);
  const abortPromise = new Promise((_, reject) => {
    actualAbortSignal.addEventListener("abort", () => {
      try {
        actualAbortSignal.throwIfAborted();
      } catch (error) {
        reject(error);
      }
    });
  });

  while (true) {
    const { status } = await Promise.race([sane.sane_start(), abortPromise]);
    try {
      if (
        status === SANEStatus.DEVICE_BUSY ||
        status === SANEStatus.JAMMED ||
        status === SANEStatus.NO_DOCS
      ) {
        // ignore
      } else if (status !== SANEStatus.GOOD) {
        throw new Error(`Failed to start scan: ${sane.sane_strstatus(status)}`);
      } else {
        const { status, parameters } = await Promise.race([
          sane.sane_get_parameters(),
          abortPromise,
        ]);
        if (
          status === SANEStatus.DEVICE_BUSY ||
          status === SANEStatus.JAMMED ||
          status === SANEStatus.NO_DOCS ||
          !parameters
        ) {
          // ignore
          continue;
        } else if (status !== SANEStatus.GOOD) {
          throw new Error(
            `Failed to get parameters: ${sane.sane_strstatus(status)}`,
          );
        }

        const buf = new Uint8Array(
          parameters.bytes_per_line * parameters.lines,
        );
        let offset = 0;
        while (true) {
          const { status, data } = await Promise.race([
            sane.sane_read(),
            abortPromise,
          ]);
          if (data) {
            buf.set(data, offset);
            offset += data.length;
          }

          if (status === SANEStatus.EOF) {
            break;
          } else if (status !== SANEStatus.GOOD) {
            throw new Error(
              `Failed to read data: ${sane.sane_strstatus(status)}`,
            );
          }
        }

        if (offset) {
          yield { parameters, data: buf.subarray(0, offset) };
        }
      }
    } finally {
      await sane.sane_cancel();
    }

    await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 100)),
      abortPromise,
    ]);
  }
}

function convertLineData(parameters, dataIn) {
  const lineCount = Math.floor(dataIn.length / parameters.bytes_per_line);
  if (!lineCount) {
    return [0, new Uint8ClampedArray()];
  }

  const dataOut = new Uint8ClampedArray(
    lineCount * parameters.pixels_per_line * 4,
  );
  let ik = 0;
  if (parameters.depth === 8) {
    if (parameters.format === SANEFrame.GRAY) {
      // 8-bit / 1 channel
      for (
        let l = 0, o = 0;
        l < lineCount;
        l++, ik += parameters.bytes_per_line
      ) {
        // for lines
        for (
          let p = 0, i = ik;
          p < parameters.pixels_per_line;
          p++, i++, o += 4
        ) {
          // for pixels
          dataOut[o] = dataOut[o + 1] = dataOut[o + 2] = dataIn[i];
          dataOut[o + 3] = 0xff; // alpha
        }
      }
    } else {
      // 8-bit / 3 channels
      for (
        let l = 0, o = 0;
        l < lineCount;
        l++, ik += parameters.bytes_per_line
      ) {
        // for lines
        for (
          let p = 0, i = ik;
          p < parameters.pixels_per_line;
          p++, i += 3, o += 4
        ) {
          // for pixels
          dataOut.set(dataIn.subarray(i, i + 3), o);
          dataOut[o + 3] = 0xff; // alpha
        }
      }
    }
  } else {
    // parameters.depth == 1
    if (parameters.format === SANEFrame.GRAY) {
      // 1-bit / 1 channel
      for (
        let l = 0, o = 0;
        l < lineCount;
        l++, ik += parameters.bytes_per_line
      ) {
        // for lines
        for (let p = 0, i = ik; p < parameters.pixels_per_line; i++) {
          // for in bytes
          for (
            let mask = 0x80;
            mask !== 0 && p < parameters.pixels_per_line;
            mask >>= 1, p++, o += 4
          ) {
            // for pixels
            dataOut[o] =
              dataOut[o + 1] =
              dataOut[o + 2] =
                dataIn[i] & mask ? 0x00 : 0xff;
            dataOut[o + 3] = 0xff; // alpha
          }
        }
      }
    } else {
      // 1-bit / 3 channels
      // niche format, probably very few (if any) scanners support this
      // according to the test backend the bits are inverted on this format, if compared
      // with 1-bit gray (1 channel), it remains to be seen if this is correct in the wild
      for (
        let l = 0, o = 0;
        l < lineCount;
        l++, ik += parameters.bytes_per_line
      ) {
        // for lines
        for (let p = 0, i = ik; p < parameters.pixels_per_line; i += 3) {
          // for in bytes
          for (
            let mask = 0x80;
            mask !== 0 && p < parameters.pixels_per_line;
            mask >>= 1, p++, o += 4
          ) {
            // for pixels
            // rbg is interlaced byte-by-byte not bit-by-bit
            // so 3 bytes have the R-G-B for 8 pixels
            dataOut[o] = dataIn[i] & mask ? 0xff : 0x00;
            dataOut[o + 1] = dataIn[i + 1] & mask ? 0xff : 0x00;
            dataOut[o + 2] = dataIn[i + 2] & mask ? 0xff : 0x00;
            dataOut[o + 3] = 0xff; // alpha
          }
        }
      }
    }
  }

  return [ik, dataOut];
}

export async function* scanImages(abortSignal) {
  for await (const { parameters, data } of scanLoop(abortSignal)) {
    const [n, imgdata] = convertLineData(parameters, data);
    if (n !== data.length) {
      console.log("Mismatched data length", n, data.length);
    }

    yield new ImageData(imgdata, parameters.pixels_per_line);
  }
}
