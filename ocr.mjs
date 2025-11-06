/**
 * OCR Module for Date and Time Detection
 *
 * This module uses Tesseract.js to perform OCR on selected receipt areas
 * and intelligently parse dates and times from the extracted text.
 *
 * Features:
 * - Automatic date format detection (MM/DD/YYYY, DD/MM/YYYY, etc.)
 * - Support for partial dates (MM/DD with expected year)
 * - Date validation with month/year constraints
 * - Leap year handling
 * - Time parsing with 12-hour (AM/PM) and 24-hour format support
 * - Automatic conversion to 24-hour format
 *
 * Example usage:
 *   const text = await recognizeText(imageData);
 *   const dateTime = parseDateTime(text, 2024, 3);
 *   // dateTime: { year: 2024, month: 3, day: 15, hour: 14, minute: 30 }
 *   const filename = formatDateForFilename(dateTime);
 *   // filename: "20240315-1430"
 */

import Tesseract from "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.esm.min.js";

let worker = null;

export async function initOCR() {
  if (worker) {
    return worker;
  }

  worker = await Tesseract.createWorker("eng", 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        console.log(`OCR Progress: ${Math.round(m.progress * 100)}%`);
      }
    },
  });

  return worker;
}

export async function terminateOCR() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}

export async function recognizeText(imageData) {
  const ocrWorker = await initOCR();

  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  const ctx = canvas.getContext("2d");
  ctx.putImageData(imageData, 0, 0);

  const { data } = await ocrWorker.recognize(canvas);
  return data.text;
}

export function parseDateTime(text, expectedYear, expectedMonth) {
  const date = parseDate(text, expectedYear, expectedMonth);
  if (!date) {
    return null;
  }

  const time = parseTime(text);

  return {
    ...date,
    hour: time?.hour ?? null,
    minute: time?.minute ?? null,
  };
}

export function parseDate(text, expectedYear, expectedMonth) {
  const cleanedText = text.replace(/[^\d\/\-\s]/g, " ").trim();

  const datePatterns = [
    /\b(\d{1,2})[/\-\s](\d{1,2})[/\-\s](\d{2,4})\b/g,
    /\b(\d{2,4})[/\-\s](\d{1,2})[/\-\s](\d{1,2})\b/g,
    /\b(\d{1,2})[/\-\s](\d{1,2})\b/g,
  ];

  const candidates = [];

  for (const pattern of datePatterns) {
    let match = pattern.exec(cleanedText);
    while (match !== null) {
      candidates.push(match[0]);
      match = pattern.exec(cleanedText);
    }
  }

  for (const candidate of candidates) {
    const parsed = tryParseDate(candidate, expectedYear, expectedMonth);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

export function parseTime(text) {
  const timePatterns = [
    /\b(\d{1,2}):(\d{2})\s*(am|pm|a\.m\.|p\.m\.)\b/gi,
    /\b(\d{1,2}):(\d{2})\b/g,
    /\b(\d{1,2})(\d{2})\s*(am|pm|a\.m\.|p\.m\.)\b/gi,
  ];

  for (const pattern of timePatterns) {
    const match = pattern.exec(text);
    if (match) {
      let hour = parseInt(match[1], 10);
      const minute = parseInt(match[2], 10);
      const meridiem = match[3]?.toLowerCase().replace(/\./g, "");

      if (minute >= 60) {
        continue;
      }

      if (meridiem) {
        if (meridiem === "pm" || meridiem === "pm") {
          if (hour !== 12) {
            hour += 12;
          }
        } else if (meridiem === "am" || meridiem === "am") {
          if (hour === 12) {
            hour = 0;
          }
        }
      }

      if (hour >= 24) {
        continue;
      }

      return { hour, minute };
    }
  }

  return null;
}

function tryParseDate(dateStr, expectedYear, expectedMonth) {
  const parts = dateStr.split(/[\/\-\s]+/).map((p) => parseInt(p, 10));

  if (parts.length < 2 || parts.some(Number.isNaN)) {
    return null;
  }

  if (parts.length === 2) {
    const possibleDates = [
      { month: parts[0], day: parts[1], year: expectedYear },
      { month: parts[1], day: parts[0], year: expectedYear },
    ];

    for (const date of possibleDates) {
      if (
        isValidDate(date.year, date.month, date.day) &&
        (!expectedYear || date.year === expectedYear) &&
        (!expectedMonth || date.month === expectedMonth)
      ) {
        return date;
      }
    }
    return null;
  }

  if (parts.length === 3) {
    const [a, b, c] = parts;

    const possibleDates = [
      { month: a, day: b, year: c < 100 ? 2000 + c : c },
      { month: b, day: a, year: c < 100 ? 2000 + c : c },
      { month: b, day: c, year: a < 100 ? 2000 + a : a },
      { month: a, day: c, year: b < 100 ? 2000 + b : b },
      { month: c, day: b, year: a < 100 ? 2000 + a : a },
      { month: c, day: a, year: b < 100 ? 2000 + b : b },
    ];

    for (const date of possibleDates) {
      if (
        isValidDate(date.year, date.month, date.day) &&
        (!expectedYear || date.year === expectedYear) &&
        (!expectedMonth || date.month === expectedMonth)
      ) {
        return date;
      }
    }
    return null;
  }

  return null;
}

function isValidDate(year, month, day) {
  if (!year || !month || !day) return false;
  if (year < 2000 || year > 2099) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;

  const daysInMonth = [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (day > daysInMonth[month - 1]) return false;

  return true;
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function formatDateForFilename(date) {
  const year = date.year.toString();
  const month = date.month.toString().padStart(2, "0");
  const day = date.day.toString().padStart(2, "0");

  if (date.hour !== null && date.minute !== null) {
    const hour = date.hour.toString().padStart(2, "0");
    const minute = date.minute.toString().padStart(2, "0");
    return `${year}${month}${day}-${hour}${minute}`;
  }

  return `${year}${month}${day}-`;
}
