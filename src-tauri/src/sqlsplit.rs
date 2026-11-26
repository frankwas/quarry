//! Splits a SQL script into statements the way the mysql CLI does: respects
//! quotes, backticks, comments and the client-side `DELIMITER` directive.
//! The UI has a TypeScript twin (src/app/core/sql-split.ts) for "run statement
//! at cursor"; this one is used for importing .sql files.

pub struct Splitter {
    delimiter: String,
    buf: String,
}

impl Splitter {
    pub fn new() -> Self {
        Self { delimiter: ";".into(), buf: String::new() }
    }

    /// Feed a chunk of text; returns the statements completed by it.
    pub fn push(&mut self, chunk: &str) -> Vec<String> {
        self.buf.push_str(chunk);
        let mut out = Vec::new();
        loop {
            match self.scan() {
                Some((stmt, consumed)) => {
                    self.buf.drain(..consumed);
                    if let Some(s) = stmt {
                        out.push(s);
                    }
                }
                None => break,
            }
        }
        out
    }

    /// Whatever is left once the input is exhausted.
    pub fn finish(&mut self) -> Option<String> {
        let rest = std::mem::take(&mut self.buf);
        let t = rest.trim();
        if t.is_empty() || is_only_comments(t) { None } else { Some(t.to_string()) }
    }

    /// Finds the next complete statement in `buf`. Returns (statement, bytes
    /// consumed). A `None` statement means a directive was consumed.
    fn scan(&mut self) -> Option<(Option<String>, usize)> {
        let b = self.buf.as_bytes();
        let n = b.len();
        let mut i = 0;
        // DELIMITER directive at the start of a line (after leading whitespace)
        let lead = b.iter().take_while(|c| c.is_ascii_whitespace()).count();
        if n - lead >= 10 && self.buf[lead..lead + 10].eq_ignore_ascii_case("delimiter ") {
            let nl = self.buf[lead..].find('\n').map(|p| lead + p)?;
            let d = self.buf[lead + 10..nl].trim().to_string();
            if !d.is_empty() {
                self.delimiter = d;
            }
            return Some((None, nl + 1));
        }
        let delim = self.delimiter.as_bytes();
        while i < n {
            let c = b[i];
            match c {
                b'\'' | b'"' | b'`' => {
                    let mut j = i + 1;
                    loop {
                        if j >= n {
                            return None;
                        }
                        if b[j] == b'\\' && c != b'`' {
                            j += 2;
                            continue;
                        }
                        if b[j] == c {
                            if j + 1 < n && b[j + 1] == c {
                                j += 2;
                                continue;
                            }
                            break;
                        }
                        j += 1;
                    }
                    i = j + 1;
                }
                b'#' => match self.buf[i..].find('\n') {
                    Some(p) => i += p + 1,
                    None => return None,
                },
                b'-' if i + 2 < n && b[i + 1] == b'-' && (b[i + 2] == b' ' || b[i + 2] == b'\t' || b[i + 2] == b'\n' || b[i + 2] == b'\r') => {
                    match self.buf[i..].find('\n') {
                        Some(p) => i += p + 1,
                        None => return None,
                    }
                }
                b'/' if i + 1 < n && b[i + 1] == b'*' => match self.buf[i + 2..].find("*/") {
                    Some(p) => i += p + 4,
                    None => return None,
                },
                _ => {
                    if b[i..].starts_with(delim) {
                        let stmt = self.buf[..i].trim().to_string();
                        let consumed = i + delim.len();
                        let stmt = if stmt.is_empty() || is_only_comments(&stmt) { None } else { Some(stmt) };
                        return Some((stmt, consumed));
                    }
                    i += 1;
                }
            }
        }
        None
    }
}

fn is_only_comments(s: &str) -> bool {
    let mut rest = s.trim();
    loop {
        if rest.is_empty() {
            return true;
        }
        if rest.starts_with("--") || rest.starts_with('#') {
            rest = match rest.find('\n') {
                Some(p) => rest[p + 1..].trim_start(),
                None => "",
            };
        } else if rest.starts_with("/*") && !rest.starts_with("/*!") {
            rest = match rest.find("*/") {
                Some(p) => rest[p + 2..].trim_start(),
                None => "",
            };
        } else {
            return false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn split(s: &str) -> Vec<String> {
        let mut sp = Splitter::new();
        let mut v = sp.push(s);
        v.extend(sp.finish());
        v
    }

    #[test]
    fn basic() {
        assert_eq!(split("select 1; select 2"), vec!["select 1", "select 2"]);
    }

    #[test]
    fn quotes_and_comments() {
        let v = split("select ';' as a -- x;\n; /* ; */ select `a;b`, \"q\\\";\"; # c;\n");
        assert_eq!(v.len(), 2);
        assert!(v[1].contains("`a;b`"));
    }

    #[test]
    fn delimiter() {
        let v = split("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\nDELIMITER ;\nselect 2;");
        assert_eq!(v, vec!["CREATE PROCEDURE p() BEGIN SELECT 1; END", "select 2"]);
    }

    #[test]
    fn chunked() {
        let mut sp = Splitter::new();
        let mut v = sp.push("insert into t values ('a");
        v.extend(sp.push(";b'); select 1"));
        v.extend(sp.finish());
        assert_eq!(v, vec!["insert into t values ('a;b')", "select 1"]);
    }

    #[test]
    fn version_comment_kept() {
        let v = split("/*!40101 SET NAMES utf8 */;\nselect 1;");
        assert_eq!(v.len(), 2);
    }
}
