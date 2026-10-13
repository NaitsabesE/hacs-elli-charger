"""Shared helpers for summarizing Elli's historical charging *records*.

Used by both the on-demand monthly PDF report (`report.py`) and the
always-on "energy this month / last month / this year" + "last 10 charges"
sensors (`sensor.py`, computed by the coordinator in `__init__.py`), so the
month-boundary math, pagination and card-labelling logic only lives in one
place.
"""
from __future__ import annotations

from datetime import datetime

from homeassistant.util import dt as dt_util

from .const import REPORT_MAX_RECORD_PAGES, REPORT_RECORDS_PAGE_SIZE

_FMT = "%Y-%m-%dT%H:%M:%SZ"
UNKNOWN_CARD_LABEL = "Ohne Karte / App"


def local_bounds_to_utc(start_local: datetime, end_local: datetime) -> tuple[str, str]:
    """Convert a [start, end) local-time window to UTC ISO8601 strings."""
    return (
        dt_util.as_utc(start_local).strftime(_FMT),
        dt_util.as_utc(end_local).strftime(_FMT),
    )


def year_bounds_utc(year: int) -> tuple[str, str]:
    """Return (created_after, created_before) UTC bounds for a full local year."""
    local_tz = dt_util.DEFAULT_TIME_ZONE
    return local_bounds_to_utc(
        datetime(year, 1, 1, tzinfo=local_tz),
        datetime(year + 1, 1, 1, tzinfo=local_tz),
    )


def month_bounds_utc(year: int, month: int) -> tuple[str, str]:
    """Return (created_after, created_before) UTC bounds for a full local month."""
    local_tz = dt_util.DEFAULT_TIME_ZONE
    start_local = datetime(year, month, 1, tzinfo=local_tz)
    if month == 12:
        end_local = datetime(year + 1, 1, 1, tzinfo=local_tz)
    else:
        end_local = datetime(year, month + 1, 1, tzinfo=local_tz)
    return local_bounds_to_utc(start_local, end_local)


def fetch_station_records(
    client, station_id: str, created_after: str, created_before: str
) -> list:
    """Fetch every page of historical records for one station/date range.

    Runs in the executor - performs blocking HTTP requests. Capped at
    REPORT_MAX_RECORD_PAGES pages so a runaway API response can't hang
    forever or blow through Elli's rate limits.
    """
    records: list = []
    offset = 0
    for _ in range(REPORT_MAX_RECORD_PAGES):
        page = client.get_charging_records(
            station_id=station_id,
            created_after=created_after,
            created_before=created_before,
            limit=REPORT_RECORDS_PAGE_SIZE,
            offset=offset,
        )
        records.extend(page)
        if len(page) < REPORT_RECORDS_PAGE_SIZE:
            break
        offset += REPORT_RECORDS_PAGE_SIZE
    return records


def sum_energy_kwh(records) -> float:
    """Sum total_energy_wh across a list of ChargingRecord objects, in kWh."""
    return sum((getattr(r, "total_energy_wh", 0) or 0) for r in records) / 1000


def card_label(record) -> str:
    """Best-effort human label for the card/method used to authenticate."""
    if getattr(record, "rfid_card_serial_number", None):
        return f"RFID {record.rfid_card_serial_number}"
    if getattr(record, "authentication_method", None):
        return record.authentication_method
    return UNKNOWN_CARD_LABEL


def group_records_by_month(records) -> dict[str, dict]:
    """Aggregate records per local calendar month.

    Returns {"YYYY-MM": {"kwh": float, "charges": int, "cards": {label: kwh}}}.
    Records are de-duplicated by id; records without a parsable start time
    are skipped (they can't be assigned to a month).
    """
    by_id = {getattr(r, "id", index): r for index, r in enumerate(records)}
    months: dict[str, dict] = {}
    for record in by_id.values():
        parsed = dt_util.parse_datetime(getattr(record, "start_date_time", "") or "")
        if parsed is None:
            continue
        local = dt_util.as_local(parsed)
        key = f"{local.year:04d}-{local.month:02d}"
        kwh = (getattr(record, "total_energy_wh", 0) or 0) / 1000
        entry = months.setdefault(key, {"kwh": 0.0, "charges": 0, "cards": {}})
        entry["kwh"] += kwh
        entry["charges"] += 1
        label = card_label(record)
        entry["cards"][label] = entry["cards"].get(label, 0.0) + kwh
    return months


def build_history(months: dict[str, dict]) -> list[dict]:
    """Turn {"YYYY-MM": agg} into a newest-first list of years with 12 months each."""
    years: dict[int, dict] = {}
    for key, agg in months.items():
        year, month = int(key[:4]), int(key[5:7])
        ydata = years.setdefault(
            year,
            {
                "year": year,
                "kwh": 0.0,
                "charges": 0,
                "cards": {},
                "months": [
                    {"month": m, "kwh": 0.0, "charges": 0, "cards": {}}
                    for m in range(1, 13)
                ],
            },
        )
        mdata = ydata["months"][month - 1]
        mdata["kwh"] += agg["kwh"]
        mdata["charges"] += agg["charges"]
        ydata["kwh"] += agg["kwh"]
        ydata["charges"] += agg["charges"]
        for label, kwh in agg["cards"].items():
            mdata["cards"][label] = mdata["cards"].get(label, 0.0) + kwh
            ydata["cards"][label] = ydata["cards"].get(label, 0.0) + kwh

    def _round_cards(cards: dict) -> dict:
        return {k: round(v, 2) for k, v in sorted(cards.items(), key=lambda i: -i[1])}

    result = []
    for year in sorted(years, reverse=True):
        ydata = years[year]
        ydata["kwh"] = round(ydata["kwh"], 2)
        ydata["cards"] = _round_cards(ydata["cards"])
        for mdata in ydata["months"]:
            mdata["kwh"] = round(mdata["kwh"], 2)
            mdata["cards"] = _round_cards(mdata["cards"])
        result.append(ydata)
    return result


def most_recent_records(records, limit: int) -> list:
    """De-duplicate (by id) and return the `limit` most recent records.

    Sorted newest-first by `start_date_time`; records with a missing/
    unparsable timestamp sort last rather than raising.
    """
    by_id = {getattr(r, "id", index): r for index, r in enumerate(records)}

    _EPOCH = datetime(1970, 1, 1, tzinfo=dt_util.UTC)

    def _sort_key(record):
        parsed = dt_util.parse_datetime(getattr(record, "start_date_time", "") or "")
        return parsed or _EPOCH

    ordered = sorted(by_id.values(), key=_sort_key, reverse=True)
    return ordered[:limit]
