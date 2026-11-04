"""Server-held OAuth and identity-based, retryable personal Drive delivery."""
import json
import os
from pathlib import Path
import re
from urllib.parse import urlencode, urlsplit

import httpx

from .storage import durable_write, encode


class Drive:
    def __init__(self, settings, client=None):
        self.settings = settings
        self.client = client or httpx.Client(timeout=90)
        self.client_id = os.getenv("DRIVE_CLIENT_ID", "")
        self.client_secret = os.getenv("DRIVE_CLIENT_SECRET", "")
        self.root = os.getenv("DRIVE_ROOT_ID", "")
        self.token_path = settings.state / "drive-token.json"
        self.redirect = settings.public_url + "/api/drive/callback"

    @property
    def configured(self):
        return bool(self.client_id and self.client_secret and re.fullmatch(r"[\w-]{1,200}", self.root))

    def status(self):
        return {"configured": self.configured, "connected": self.configured and self.token_path.exists()}

    def authorization(self, state):
        if not self.configured:
            raise ValueError("Set DRIVE_CLIENT_ID, DRIVE_CLIENT_SECRET and DRIVE_ROOT_ID first")
        return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode({
            "client_id": self.client_id, "redirect_uri": self.redirect, "response_type": "code",
            "scope": "https://www.googleapis.com/auth/drive", "state": state,
            "access_type": "offline", "prompt": "consent",
        })

    def exchange(self, code):
        response = self.client.post("https://oauth2.googleapis.com/token", data={
            "client_id": self.client_id, "client_secret": self.client_secret, "code": code,
            "redirect_uri": self.redirect, "grant_type": "authorization_code"})
        if response.status_code != 200 or not response.json().get("refresh_token"):
            raise ValueError("Drive authorization failed; reconnect with offline access")
        token = response.json()
        # Validate the configured existing root without changing sharing.
        root = self.client.get(f"https://www.googleapis.com/drive/v3/files/{self.root}",
                               headers={"Authorization": f"Bearer {token['access_token']}"},
                               params={"fields": "id,mimeType,trashed,capabilities(canAddChildren)"})
        if root.status_code != 200 or root.json().get("trashed") or root.json().get("mimeType") != "application/vnd.google-apps.folder" or not root.json().get("capabilities", {}).get("canAddChildren"):
            raise ValueError("The configured Drive receipts root is not a writable folder")
        durable_write(self.token_path, encode({"refresh_token": token["refresh_token"]}).encode())

    def token(self):
        if not self.status()["connected"]:
            raise ValueError("Connect Google Drive first")
        refresh = json.loads(self.token_path.read_text())["refresh_token"]
        response = self.client.post("https://oauth2.googleapis.com/token", data={
            "client_id": self.client_id, "client_secret": self.client_secret,
            "refresh_token": refresh, "grant_type": "refresh_token"})
        if response.status_code != 200:
            raise ValueError("Drive authorization expired or unavailable; reconnect or retry")
        return response.json()["access_token"]

    def request(self, method, path, **kwargs):
        response = self.client.request(method, "https://www.googleapis.com/drive/v3/" + path,
                                       headers={"Authorization": "Bearer " + self.token()}, **kwargs)
        if response.status_code >= 400:
            # Do not log provider responses containing private filenames or credentials.
            raise ValueError(f"Drive request failed (HTTP {response.status_code}); retry or reconnect")
        return response.json()

    def find(self, query):
        files = []
        page = None
        while True:
            params = {"q": "trashed=false and (" + query + ")", "fields": "nextPageToken,files(id,name,mimeType,appProperties)", "pageSize": 1000}
            if page:
                params["pageToken"] = page
            result = self.request("GET", "files", params=params)
            files.extend(result.get("files", []))
            page = result.get("nextPageToken")
            if not page:
                return files

    @staticmethod
    def quote(value):
        return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

    def folder(self, parent, name, create=False):
        found = self.find(f"{self.quote(parent)} in parents and name={self.quote(name)}")
        if len(found) > 1 or (found and found[0]["mimeType"] != "application/vnd.google-apps.folder"):
            raise ValueError("Conflicting Drive year/month folder names need manual resolution")
        if found:
            return found[0]["id"]
        if create:
            return self.request("POST", "files", json={"name": name, "parents": [parent], "mimeType": "application/vnd.google-apps.folder"})["id"]
        return None

    def parent(self, relative, create=False):
        year, month, _ = Path(relative).parts
        parent = self.root
        for component in (year, month):
            parent = self.folder(parent, component, create)
            if not parent:
                return None
        return parent

    def names(self, year_month):
        parent = self.parent(year_month + "/placeholder.pdf")
        return {file["name"] for file in self.find(f"{self.quote(parent)} in parents")} if parent else set()

    def upload(self, export):
        identity = export["id"]
        existing = self.find("appProperties has { key='receiptExportId' and value=" + self.quote(identity) + " }")
        if len(existing) > 1:
            raise ValueError("Multiple Drive copies have this export identity; resolve before retry")
        if existing:
            if existing[0].get("appProperties", {}).get("sha256") != export["sha256"]:
                raise ValueError("Drive export identity checksum conflicts")
            return existing[0]["id"]
        parent = self.parent(export["path"], create=True)
        name = Path(export["path"]).name
        if self.find(f"{self.quote(parent)} in parents and name={self.quote(name)}"):
            raise ValueError("Drive filename was occupied after reservation; existing file was preserved")
        path = self.settings.archive / export["path"]
        token = self.token()
        response = self.client.post("https://www.googleapis.com/upload/drive/v3/files", params={"uploadType": "resumable"},
            headers={"Authorization": "Bearer " + token, "X-Upload-Content-Type": "application/pdf", "X-Upload-Content-Length": str(path.stat().st_size)},
            json={"name": name, "parents": [parent], "appProperties": {"receiptExportId": identity, "sha256": export["sha256"]}})
        location = response.headers.get("Location", "")
        if response.status_code != 200 or urlsplit(location).scheme != "https" or urlsplit(location).hostname != "www.googleapis.com":
            raise ValueError("Drive resumable upload could not be initialized")
        with path.open("rb") as source:
            response = self.client.put(location, headers={"Authorization": "Bearer " + token, "Content-Type": "application/pdf", "Content-Length": str(path.stat().st_size)}, content=source)
        if response.status_code not in (200, 201):
            raise ValueError("Drive upload interrupted; retry reconciles the export identity")
        return response.json()["id"]
