//! Saved connection profiles. Profiles live in `connections.json` in the app
//! config dir; secrets (DB password, SSH password / key passphrase) live in the
//! OS credential store (Windows Credential Manager) and never touch disk.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const KEYRING_SERVICE: &str = "dev.quarry.app";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disabled,
    Preferred,
    Required,
    Verify,
}

impl Default for SslMode {
    fn default() -> Self {
        SslMode::Preferred
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SshAuth {
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth: SshAuth,
    #[serde(default)]
    pub key_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub group: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub ssl: SslMode,
    #[serde(default)]
    pub ssh: Option<SshConfig>,
    /// Refuse writes from the editor and grid for this connection.
    #[serde(default)]
    pub read_only: bool,
}

/// Secrets supplied by the UI. `None` means "leave the stored value alone",
/// `Some("")` means "clear it".
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Secrets {
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub ssh_secret: Option<String>,
}

pub struct Store {
    path: PathBuf,
    pub conns: Vec<ConnConfig>,
}

impl Store {
    pub fn load(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir).ok();
        let path = dir.join("connections.json");
        let conns = match std::fs::read_to_string(&path) {
            Ok(s) => serde_json::from_str(&s).context("connections.json is not valid")?,
            Err(_) => Vec::new(),
        };
        Ok(Self { path, conns })
    }

    fn persist(&self) -> Result<()> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.conns)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Option<ConnConfig> {
        self.conns.iter().find(|c| c.id == id).cloned()
    }

    pub fn upsert(&mut self, cfg: ConnConfig, secrets: &Secrets) -> Result<ConnConfig> {
        if let Some(p) = &secrets.password {
            set_secret(&cfg.id, "db", p)?;
        }
        if let Some(p) = &secrets.ssh_secret {
            set_secret(&cfg.id, "ssh", p)?;
        }
        match self.conns.iter_mut().find(|c| c.id == cfg.id) {
            Some(existing) => *existing = cfg.clone(),
            None => self.conns.push(cfg.clone()),
        }
        self.persist()?;
        Ok(cfg)
    }

    pub fn delete(&mut self, id: &str) -> Result<()> {
        self.conns.retain(|c| c.id != id);
        let _ = set_secret(id, "db", "");
        let _ = set_secret(id, "ssh", "");
        self.persist()
    }

    pub fn reorder(&mut self, ids: &[String]) -> Result<()> {
        self.conns
            .sort_by_key(|c| ids.iter().position(|i| *i == c.id).unwrap_or(usize::MAX));
        self.persist()
    }
}

fn entry(id: &str, kind: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYRING_SERVICE, &format!("{id}:{kind}")).map_err(|e| anyhow::anyhow!("credential store: {e}"))
}

pub fn set_secret(id: &str, kind: &str, value: &str) -> Result<()> {
    let e = entry(id, kind)?;
    if value.is_empty() {
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(anyhow::anyhow!("credential store: {err}")),
        }
    } else {
        e.set_password(value).map_err(|err| anyhow::anyhow!("credential store: {err}"))
    }
}

pub fn get_secret(id: &str, kind: &str) -> Option<String> {
    entry(id, kind).ok()?.get_password().ok().filter(|s| !s.is_empty())
}

pub fn has_secret(id: &str, kind: &str) -> bool {
    get_secret(id, kind).is_some()
}
