//! A minimal VT screen model for tests that check what the user would see.

/// A minimal VT screen: printable text, CR, LF, BS, `CSI K`, `CSI A`, `CSI J`,
/// autowrap. Everything else is ignored.
pub(crate) struct Screen {
    cols: usize,
    rows: Vec<Vec<char>>,
    r: usize,
    c: usize,
}

impl Screen {
    pub(crate) fn new(cols: usize) -> Self {
        Self {
            cols,
            rows: vec![Vec::new()],
            r: 0,
            c: 0,
        }
    }

    fn row(&mut self) -> &mut Vec<char> {
        while self.rows.len() <= self.r {
            self.rows.push(Vec::new());
        }
        &mut self.rows[self.r]
    }

    pub(crate) fn feed(&mut self, data: &[u8]) {
        let text = String::from_utf8_lossy(data).to_string();
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            match ch {
                '\r' => self.c = 0,
                '\n' => self.r += 1,
                '\x08' => self.c = self.c.saturating_sub(1),
                '\x1b' => match chars.next() {
                    Some('[') => {
                        let mut params = String::new();
                        let mut fin = ' ';
                        for n in chars.by_ref() {
                            if ('@'..='~').contains(&n) {
                                fin = n;
                                break;
                            }
                            params.push(n);
                        }
                        let n: usize = params.trim_start_matches('?').parse().unwrap_or(0);
                        match fin {
                            'K' if n == 2 => self.row().clear(),
                            'K' => {
                                let c = self.c;
                                self.row().truncate(c);
                            }
                            'A' => self.r = self.r.saturating_sub(n.max(1)),
                            'J' => {
                                let (r, c) = (self.r, self.c);
                                self.row().truncate(c);
                                self.rows.truncate(r + 1);
                            }
                            _ => {}
                        }
                    }
                    Some(']') => {
                        let mut prev = ' ';
                        for n in chars.by_ref() {
                            if n == '\x07' || (prev == '\x1b' && n == '\\') {
                                break;
                            }
                            prev = n;
                        }
                    }
                    _ => {}
                },
                c if c.is_control() => {}
                c => {
                    if self.c >= self.cols {
                        self.r += 1;
                        self.c = 0;
                    }
                    let col = self.c;
                    let row = self.row();
                    while row.len() < col {
                        row.push(' ');
                    }
                    if col < row.len() {
                        row[col] = c;
                    } else {
                        row.push(c);
                    }
                    self.c += 1;
                }
            }
        }
    }

    pub(crate) fn lines(&self) -> Vec<String> {
        let mut lines: Vec<String> = self
            .rows
            .iter()
            .map(|r| r.iter().collect::<String>().trim_end().to_string())
            .collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        lines
    }
}
