//! SSH tunnel: authenticate to a bastion, listen on an ephemeral localhost port
//! and forward every accepted socket through a direct-tcpip channel to the
//! MySQL host as seen from the bastion.
//!
//! Host keys are trust-on-first-use: the first fingerprint seen for host:port
//! is recorded in `known_hosts.json`; a different key later is refused.

use crate::store::{SshAuth, SshConfig};
use anyhow::{anyhow, bail, Context, Result};
use russh::client;
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

pub struct Tunnel {
    pub local_port: u16,
    accept_task: JoinHandle<()>,
    handle: Arc<client::Handle<Client>>,
}

impl Tunnel {
    pub async fn close(self) {
        self.accept_task.abort();
        let _ = self
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    }
}

pub struct Client {
    host_id: String,
    known_hosts: PathBuf,
    /// Set when the server key does not match the recorded one, so the caller
    /// can report something more useful than "unknown key".
    mismatch: Arc<Mutex<Option<String>>>,
}

fn load_known(path: &PathBuf) -> HashMap<String, String> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = match key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.fingerprint(HashAlg::Sha256).to_string(),
            PublicKeyOrCertificate::Certificate(cert) => {
                cert.public_key().fingerprint(HashAlg::Sha256).to_string()
            }
        };
        let mut known = load_known(&self.known_hosts);
        match known.get(&self.host_id) {
            Some(existing) if *existing == fp => Ok(true),
            Some(existing) => {
                *self.mismatch.lock().unwrap() = Some(format!(
                    "SSH host key for {} changed (expected {existing}, got {fp}). \
                     If this is expected, remove the entry from {}",
                    self.host_id,
                    self.known_hosts.display()
                ));
                Ok(false)
            }
            None => {
                known.insert(self.host_id.clone(), fp);
                if let Ok(s) = serde_json::to_string_pretty(&known) {
                    let _ = std::fs::write(&self.known_hosts, s);
                }
                Ok(true)
            }
        }
    }
}

pub async fn open(
    cfg: &SshConfig,
    secret: Option<String>,
    target_host: &str,
    target_port: u16,
    known_hosts: PathBuf,
) -> Result<Tunnel> {
    let config = Arc::new(client::Config {
        nodelay: true,
        inactivity_timeout: None,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        ..Default::default()
    });
    let mismatch = Arc::new(Mutex::new(None));
    let handler = Client {
        host_id: format!("{}:{}", cfg.host, cfg.port),
        known_hosts,
        mismatch: mismatch.clone(),
    };

    let mut session = match tokio::time::timeout(
        std::time::Duration::from_secs(15),
        client::connect(config, (cfg.host.as_str(), cfg.port), handler),
    )
    .await
    {
        Err(_) => bail!("SSH connect to {}:{} timed out", cfg.host, cfg.port),
        Ok(Err(e)) => {
            if let Some(m) = mismatch.lock().unwrap().take() {
                bail!(m);
            }
            return Err(anyhow!(e)).context(format!("SSH connect to {}:{}", cfg.host, cfg.port));
        }
        Ok(Ok(s)) => s,
    };

    let auth = match cfg.auth {
        SshAuth::Password => {
            let pw = secret.ok_or_else(|| anyhow!("no SSH password saved for this connection"))?;
            session.authenticate_password(cfg.user.clone(), pw).await?
        }
        SshAuth::Key => {
            let path = cfg
                .key_path
                .clone()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| anyhow!("no SSH key file set for this connection"))?;
            let path = expand_home(&path);
            let key = russh::keys::load_secret_key(&path, secret.as_deref())
                .with_context(|| format!("loading SSH key {}", path.display()))?;
            let hash = session.best_supported_rsa_hash().await?.flatten();
            session
                .authenticate_publickey(cfg.user.clone(), PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
        }
    };
    if !auth.success() {
        bail!("SSH authentication failed for {}@{}", cfg.user, cfg.host);
    }

    let handle = Arc::new(session);
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let local_port = listener.local_addr()?.port();
    let target_host = target_host.to_string();
    let h = handle.clone();
    let accept_task = tokio::spawn(async move {
        loop {
            let Ok((mut socket, peer)) = listener.accept().await else { break };
            let h = h.clone();
            let target_host = target_host.clone();
            tokio::spawn(async move {
                let channel = match h
                    .channel_open_direct_tcpip(target_host, target_port as u32, peer.ip().to_string(), peer.port() as u32)
                    .await
                {
                    Ok(c) => c,
                    Err(_) => return,
                };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
            });
        }
    });

    Ok(Tunnel { local_port, accept_task, handle })
}

fn expand_home(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}
