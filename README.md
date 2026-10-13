# Elli Charger Integration for Home Assistant

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://github.com/custom-components/hacs)
[![GitHub Release](https://img.shields.io/github/release/marcszy91/hacs-elli-charger.svg)](https://github.com/marcszy91/hacs-elli-charger/releases)

Home Assistant integration for Elli charging stations (wallboxes). Monitor your charging sessions and station status directly in Home Assistant.

## Features

- Real-time charging session monitoring (status, energy, power)
- Energy totals for this month, last month and this year
- The last 10 charges, like the list in the Elli app
- All-time charging history (year → month → RFID card)
- Bundled dashboard card with a Grafana-style year/month overview
- Monthly PDF report per RFID card, optionally sent by e-mail
- All sensors grouped under one device per wallbox
- Browser-based login (no password stored), automatic token refresh and re-authentication
- Configurable polling interval

## Installation

### HACS (Recommended)

1. Open HACS in Home Assistant
2. Go to "Integrations"
3. Click the three dots in the top right corner
4. Select "Custom repositories"
5. Add the repository URL: `https://github.com/marcszy91/hacs-elli-charger`
6. Select category: "Integration"
7. Click "Add"
8. Find "Elli Charger" in the integration list
9. Click "Download"
10. Restart Home Assistant

### Manual Installation

1. Download the latest release from [GitHub](https://github.com/marcszy91/hacs-elli-charger/releases)
2. Extract the files to your `custom_components` directory:
   ```
   custom_components/elli_charger/
   ```
3. Restart Home Assistant

## Configuration

Elli's login requires a security check that only works in a real browser, so Home Assistant cannot log in with your password directly. Instead:

1. Go to **Settings** → **Devices & Services**
2. Click **+ Add Integration** and search for "Elli Charger"
3. Open the **Log in to Elli** link shown in the dialog and log in with your Elli account
4. Your browser will then try to open a link starting with `com.elli.ios.emsp://…` and fail – that's expected. Copy that **complete** link from the address bar / error page
5. Paste it into the dialog and submit

Only a revocable refresh token is stored, never your password. If it ever becomes invalid, Home Assistant shows a **Reauthenticate** prompt that walks you through the same steps.

### Options

Under **Settings** → **Devices & Services** → **Elli Charger** → **Configure** you can change the polling interval (1–60 minutes, default 5). The change applies immediately.

## Sensors

All sensors of a wallbox belong to one device named after the station. Entity IDs follow the device name, e.g. `sensor.<station>_session_energy`.

| Sensor | Unit | Description |
|---|---|---|
| Status | – | `idle` / `connected` / `charging` (translated in the UI). Attributes: station ID, name, serial number, model, firmware version |
| Last Session | – | Charging state of the current/last session. Attributes: energy, power, RFID card, authentication method, start/end time, … |
| Session Energy | kWh | Energy of the current/last session; keeps its value between sessions (Energy Dashboard ready) |
| Session Power | W | Current charging power, `0` when not charging |
| Energy This Month | kWh | Charged so far this calendar month |
| Energy Last Month | kWh | Charged in the previous calendar month |
| Energy This Year | kWh | Charged so far this calendar year |
| Energy History | kWh | All-time total; attribute `years` holds the year → month → card breakdown used by the dashboard card |
| Last charges 1–10 | kWh | One sensor per recent charge (1 = most recent). Name = start date/time, state = energy. Attributes: card, start/end time, label |

The month/year, history and last-charges sensors are calculated from Elli's charging history and refreshed about once an hour, so they may take a few minutes to fill after a restart.

## Dashboard card

The integration ships its own card, `custom:elli-history-card`. It is registered automatically – you do **not** need to add a resource in HACS or under *Dashboards → Resources*.

**Add it via the UI:** open a dashboard → **Edit** → **Add card** → search for **"Elli Ladehistorie"** (or choose *Manual* and paste the YAML below).

**Minimal configuration** (the Energy History sensor is detected automatically):

```yaml
type: custom:elli-history-card
```

**All options:**

```yaml
type: custom:elli-history-card
entity: sensor.my_wallbox_energy_history   # optional, auto-detected if omitted
title: Wallbox · Ladehistorie               # optional
price_per_kwh: 0.32                         # optional, shows costs per year/month
currency: "€"                               # optional, default "€"
compare: true                               # previous year as ghost bars (default true)
theme: dark                                 # dark (Grafana look, default) | ha (follow HA theme)
card_names:                                 # optional: friendly names for RFID cards
  "RFID 04A1B2C3": Markus
```

The card shows year totals, average per month, number of charges, year-over-year change, a monthly bar chart (hover for details per RFID card) and an expandable year/month table.

> If the card doesn't appear right after updating, reload the browser (Ctrl+F5) once. On a fresh install the history is loaded a few minutes after the first start.

## Monthly report (PDF)

The service `elli_charger.send_monthly_report` creates a PDF with the kWh charged per RFID card for one month and stores it in `/config/www/elli_charger/`. Optionally it sends the PDF through a `notify` service (the SMTP notify platform attaches it to the e-mail).

```yaml
action: elli_charger.send_monthly_report
data:
  month: "2026-09"                 # optional, defaults to last month
  notify_service: notify.email_me  # optional, leave empty to only create the PDF
  target: "you@example.com"        # optional, forwarded to the notify service
```

Example automation – send last month's report on the 1st of every month:

```yaml
automation:
  - alias: "Elli monthly report"
    triggers:
      - trigger: time
        at: "08:00:00"
    conditions:
      - condition: template
        value_template: "{{ now().day == 1 }}"
    actions:
      - action: elli_charger.send_monthly_report
        data:
          notify_service: notify.email_me
```

## Usage Examples

Replace `my_wallbox` with the entity ID prefix of your wallbox.

### Automation: Notify when charging complete

```yaml
automation:
  - alias: "Notify when EV charging complete"
    trigger:
      - platform: numeric_state
        entity_id: sensor.my_wallbox_session_power
        below: 100
        for:
          minutes: 5
    condition:
      - condition: numeric_state
        entity_id: sensor.my_wallbox_session_energy
        above: 5
    action:
      - service: notify.mobile_app
        data:
          message: "EV charging complete! {{ states('sensor.my_wallbox_session_energy') }} kWh charged"
```

### Energy Dashboard

Add the energy sensor to your Home Assistant Energy Dashboard:

1. Go to **Settings** → **Dashboards** → **Energy**
2. Under "Electricity grid" → "Add consumption"
3. Select the **Session Energy** sensor of your wallbox (e.g. `sensor.my_wallbox_session_energy`)

## API Client

This integration uses the [elli-client](https://pypi.org/project/elli-client/) Python package for communication with the Elli API.

## Support

- [Report Issues](https://github.com/marcszy91/hacs-elli-charger/issues)
- [Feature Requests](https://github.com/marcszy91/hacs-elli-charger/issues)

## License

MIT License - see [LICENSE](LICENSE) file for details

## Disclaimer

This integration is not officially supported by Elli or Volkswagen Group Charging GmbH. Use at your own risk.
