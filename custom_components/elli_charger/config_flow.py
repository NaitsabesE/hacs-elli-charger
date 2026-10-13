"""Config flow for Elli Charger integration.

Elli's Auth0-hosted login now requires an interactive Cloudflare Turnstile
challenge (confirmed against elli-client 1.5.0, see IMPROVEMENTS.md). Direct
username/password login from server-side code - what this flow used to do -
is therefore unreliable by design, not just flaky. `elli-client` >= 1.1.0
instead exposes a browser-based Authorization Code + PKCE flow:

1. `client.create_authorization()` builds an `authorization_url` (no network
   call) that the user opens in *any* real browser and logs into personally
   (that's what actually clears the Turnstile challenge).
2. Elli redirects to a custom mobile-app URL scheme
   (`com.elli.ios.emsp://.../callback?code=...&state=...`) that a browser on
   a PC can't open. The user copies that failed/undeliverable URL from the
   address bar and pastes it back into this config flow.
3. `client.exchange_callback(callback_url, authorization)` validates the
   `state` and exchanges the `code` for tokens.

We then store only the resulting (opaque, revocable) refresh token - never
the account password.
"""
from __future__ import annotations

import base64
import json
import logging
import secrets
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import selector

from elli_client import (
    AuthorizationSession,
    ElliAPIClient,
    InvalidOAuthCallback,
    TokenExchangeError,
    TokenResponse,
)

from .const import (
    CONF_ACCOUNT_LABEL,
    CONF_REFRESH_TOKEN,
    CONF_SCAN_INTERVAL,
    DEFAULT_SCAN_INTERVAL_MINUTES,
    DOMAIN,
    MAX_SCAN_INTERVAL_MINUTES,
    MIN_SCAN_INTERVAL_MINUTES,
)

_LOGGER = logging.getLogger(__name__)

STEP_CALLBACK_SCHEMA = vol.Schema({vol.Required("callback_url"): str})


def _create_authorization() -> AuthorizationSession:
    """Build a fresh authorization session (blocking client construction)."""
    client = ElliAPIClient()
    try:
        return client.create_authorization()
    finally:
        client.close()


def _exchange_callback(
    callback_url: str, authorization: AuthorizationSession
) -> TokenResponse:
    """Exchange the pasted callback URL for tokens (blocking network call)."""
    client = ElliAPIClient()
    try:
        return client.exchange_callback(callback_url, authorization)
    finally:
        client.close()


def _decode_jwt_claim(token: str | None, claim: str) -> str | None:
    """Best-effort, UNVERIFIED read of one claim from a JWT.

    Used only to get a human-friendly label (e.g. the account email) for the
    config entry title/unique_id. Never used for any security decision - the
    token's signature is intentionally not checked here.
    """
    if not token or token.count(".") != 2:
        return None
    try:
        payload_b64 = token.split(".")[1]
        padded = payload_b64 + "=" * (-len(payload_b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded))
        value = payload.get(claim)
        return str(value) if value else None
    except Exception:  # pylint: disable=broad-except
        return None


def _account_label(tokens: TokenResponse) -> str:
    """Derive a display label for the account from the tokens we got back."""
    for token, claim in (
        (tokens.id_token, "email"),
        (tokens.access_token, "email"),
        (tokens.id_token, "sub"),
        (tokens.access_token, "sub"),
    ):
        if label := _decode_jwt_claim(token, claim):
            return label
    # Nothing decodable - fall back to a short random, still-stable label.
    return f"account-{secrets.token_hex(3)}"


class ElliConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for Elli Charger."""

    # Deliberately left at 1: the auth data shape changed (refresh token
    # instead of email/password), but that's handled at runtime in
    # `async_setup_entry` (which raises ConfigEntryAuthFailed for old
    # entries, triggering the reauth flow below) rather than via Home
    # Assistant's entry-version migration machinery, since there is no
    # actual field-by-field data to migrate - only a full new login.
    VERSION = 1

    def __init__(self) -> None:
        """Initialize the config flow."""
        self._reauth_entry: config_entries.ConfigEntry | None = None
        self._authorization: AuthorizationSession | None = None

    async def _async_new_authorization_form(
        self, step_id: str, errors: dict[str, str]
    ) -> FlowResult:
        """(Re)generate the authorization link and show the paste-back form.

        A fresh link is generated every time this is shown (including after
        an error) because Auth0's authorization codes are short-lived and
        single-use.
        """
        self._authorization = await self.hass.async_add_executor_job(
            _create_authorization
        )
        return self.async_show_form(
            step_id=step_id,
            data_schema=STEP_CALLBACK_SCHEMA,
            description_placeholders={
                "authorize_url": self._authorization.authorization_url
            },
            errors=errors,
        )

    async def _async_exchange(self, callback_url: str) -> TokenResponse:
        """Exchange the pasted callback URL, translating errors."""
        assert self._authorization is not None
        try:
            return await self.hass.async_add_executor_job(
                _exchange_callback, callback_url, self._authorization
            )
        except InvalidOAuthCallback as err:
            _LOGGER.error("Invalid Elli OAuth callback: %s", err)
            raise InvalidCallback from err
        except TokenExchangeError as err:
            _LOGGER.error("Elli token exchange failed: %s", err)
            raise CannotConnect from err

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Handle the initial step: show the login link, then the paste-back form."""
        errors: dict[str, str] = {}

        if user_input is not None:
            try:
                tokens = await self._async_exchange(user_input["callback_url"])
            except InvalidCallback:
                errors["base"] = "invalid_callback"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except Exception:  # pylint: disable=broad-except
                _LOGGER.exception("Unexpected exception")
                errors["base"] = "unknown"
            else:
                label = _account_label(tokens)
                await self.async_set_unique_id(label)
                self._abort_if_unique_id_configured()

                return self.async_create_entry(
                    title=f"Elli ({label})",
                    data={
                        CONF_REFRESH_TOKEN: tokens.refresh_token,
                        CONF_ACCOUNT_LABEL: label,
                    },
                )

        return await self._async_new_authorization_form("user", errors)

    async def async_step_reauth(self, entry_data: dict[str, Any]) -> FlowResult:
        """Handle re-authentication triggered by ConfigEntryAuthFailed.

        This now happens when Elli/Auth0 rejects our *refresh token*
        (revoked, expired, or the account requires a fresh interactive
        login) - Home Assistant surfaces a "Reauthenticate" notification
        that walks the user through the same browser+paste flow again,
        rather than silently failing forever.
        """
        self._reauth_entry = self.hass.config_entries.async_get_entry(
            self.context["entry_id"]
        )
        return await self.async_step_reauth_confirm()

    async def async_step_reauth_confirm(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Ask the user to redo the browser login for reauth."""
        errors: dict[str, str] = {}
        assert self._reauth_entry is not None

        if user_input is not None:
            try:
                tokens = await self._async_exchange(user_input["callback_url"])
            except InvalidCallback:
                errors["base"] = "invalid_callback"
            except CannotConnect:
                errors["base"] = "cannot_connect"
            except Exception:  # pylint: disable=broad-except
                _LOGGER.exception("Unexpected exception during reauth")
                errors["base"] = "unknown"
            else:
                label = _account_label(tokens)
                self.hass.config_entries.async_update_entry(
                    self._reauth_entry,
                    data={
                        **self._reauth_entry.data,
                        CONF_REFRESH_TOKEN: tokens.refresh_token,
                        CONF_ACCOUNT_LABEL: label,
                    },
                )
                await self.hass.config_entries.async_reload(
                    self._reauth_entry.entry_id
                )
                return self.async_abort(reason="reauth_successful")

        return await self._async_new_authorization_form("reauth_confirm", errors)

    @staticmethod
    @callback
    def async_get_options_flow(
        config_entry: config_entries.ConfigEntry,
    ) -> ElliOptionsFlow:
        """Create the options flow (Improvement #7: configurable polling)."""
        return ElliOptionsFlow(config_entry)


class ElliOptionsFlow(config_entries.OptionsFlow):
    """Handle Elli Charger options (currently: the polling interval)."""

    def __init__(self, config_entry: config_entries.ConfigEntry) -> None:
        """Initialize options flow."""
        self.config_entry = config_entry

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        """Manage the options."""
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)

        current = self.config_entry.options.get(
            CONF_SCAN_INTERVAL, DEFAULT_SCAN_INTERVAL_MINUTES
        )

        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema(
                {
                    vol.Required(
                        CONF_SCAN_INTERVAL, default=current
                    ): selector.NumberSelector(
                        selector.NumberSelectorConfig(
                            min=MIN_SCAN_INTERVAL_MINUTES,
                            max=MAX_SCAN_INTERVAL_MINUTES,
                            step=1,
                            mode=selector.NumberSelectorMode.BOX,
                            unit_of_measurement="min",
                        )
                    ),
                }
            ),
        )


class CannotConnect(HomeAssistantError):
    """Error to indicate we cannot connect."""


class InvalidCallback(HomeAssistantError):
    """Error to indicate the pasted callback URL was rejected."""
