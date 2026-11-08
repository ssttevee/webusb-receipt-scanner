from datetime import date as Date, time as Time
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

LANGUAGES = Literal["eng", "fra", "jpn", "chi_tra", "chi_sim"]


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class Frame(Model):
    format: Literal[0, 1]
    depth: Literal[8]
    bytes_per_line: int = Field(gt=0, le=65536)
    pixels_per_line: int = Field(gt=0, le=16384)
    lines: int = Field(ge=-1, le=1000000)
    last_frame: Literal[True]


class ScanPolicy(Model):
    century: Literal[1900, 2000] | None
    expected_month: str | None = Field(default=None, pattern=r"^2\d{3}-(?:0[1-9]|1[0-2])$")


class Capture(Model):
    id: str
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    byte_length: int = Field(gt=0, le=256 * 1048576)
    kind: Literal["scanner-raw", "image"]
    width: int = Field(gt=0, le=16384)
    height: int = Field(gt=0, le=1000000)
    dpi_x: int = Field(ge=50, le=1200)
    dpi_y: int = Field(ge=50, le=1200)
    frame: Frame | None = None
    transport_complete: Literal[True]
    languages: list[LANGUAGES] = Field(default_factory=lambda: ["eng"], min_length=1, max_length=5)
    scanner: dict = Field(default_factory=dict)
    timestamp_policy: ScanPolicy | None = None

    @model_validator(mode="after")
    def check_frame(self):
        if str(UUID(self.id)) != self.id:
            raise ValueError("Canonical UUID required")
        if self.width * self.height > 160000000:
            raise ValueError("Image exceeds pixel limit")
        if self.kind == "scanner-raw":
            frame = self.frame
            if not frame or frame.pixels_per_line != self.width or frame.lines not in (-1, self.height):
                raise ValueError("Inconsistent frame dimensions")
            if frame.bytes_per_line < self.width * (3 if frame.format == 1 else 1):
                raise ValueError("Short row stride")
            if frame.bytes_per_line * self.height != self.byte_length:
                raise ValueError("Incomplete frame rows")
        return self


class Edit(Model):
    version: int = Field(gt=0)
    date: str | None = None
    time: str | None = None
    vendor: str | None = Field(default=None, max_length=200)
    complete: bool
    readable: bool

    @model_validator(mode="after")
    def calendar(self):
        if self.date and (len(self.date) != 10 or Date.fromisoformat(self.date).isoformat() != self.date):
            raise ValueError("Use YYYY-MM-DD")
        if self.time and (len(self.time) not in (5, 8) or Time.fromisoformat(self.time).isoformat()[:len(self.time)] != self.time):
            raise ValueError("Use HH:MM or HH:MM:SS")
        self.date, self.time = self.date or None, self.time or None
        self.vendor = (self.vendor or "").strip() or None
        return self


class Version(Model):
    version: int = Field(gt=0)


class ConfirmProposed(Model):
    groups: dict[str, int] = Field(min_length=1, max_length=100)
    receipt_ids: list[str] = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def unique_pages(self):
        if len(set(self.receipt_ids)) != len(self.receipt_ids):
            raise ValueError("Duplicate page selection")
        return self


class Membership(Model):
    groups: dict[str, int] = Field(min_length=1, max_length=100)
    receipt_ids: list[str] = Field(min_length=1, max_length=100)


class Approval(Version):
    export_id: str


class AnalysisRequest(Version):
    mode: Literal["parse", "ocr"] = "parse"
    date_order: Literal["inherit", "MDY", "DMY", "YMD"] | None = "inherit"
    century: Literal["inherit", 1900, 2000] | None = "inherit"
