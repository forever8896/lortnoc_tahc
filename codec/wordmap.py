"""
lortnoc_tahc codec — deterministic, reversible, plain-ASCII cover-text coder.

Contract (PRD §7):
    encode(ciphertext_bytes) -> cover_text   (plain ASCII words, space-separated)
    decode(cover_text)       -> ciphertext_bytes
    decode(encode(x)) == x   for all byte strings, deterministically.

This is the LOCKED-CONTRACT PLACEHOLDER for the hero demo. It maps each ciphertext
byte to one word from a fixed 256-word table, so the output is byte-exact-reversible
and contains only plain lowercase ASCII words + single spaces (invariant §4: no
markdown, emoji, smart quotes, or edge whitespace that Telegram might normalize).

The real steganographic coder (GPT-2 arithmetic coding, CLAUDE.md §6.2) replaces THIS
FILE behind the same `encode`/`decode` signatures — nothing else changes. Until then
the cover text is word-like rather than grammatical; that's expected.
"""

import coder  # for NotCoverText — the "ordinary chatter" signal server.py maps to 422

# A pool of common lowercase ASCII words; the first 256 unique ones form the byte table.
_POOL = (
    "the of and to in is that it for on with as was at by an be this from or had "
    "not are but have they we all one you your can has more will each about which "
    "time when up out them then she many some these would other into him his "
    "how our over new take only little work know place year live me back give most "
    "very after thing just name good sentence man think say great where help through "
    "much before line right too mean old any same tell boy follow came want show also "
    "around form three small set put end does another well large must big even such "
    "because turn here why ask went men read need land different home us move try kind "
    "hand picture again change play spell air away animal house point page letter "
    "mother answer found study still learn should america world high every near add "
    "food between own below country plant last school father keep tree never start "
    "city earth eye light thought head under story saw left few while along might "
    "close something seem next hard open example begin life always those both paper "
    "together got group often run important until children side feet car mile night "
    "walk white sea began grow took river four carry state once book hear stop "
    "second later miss idea enough eat face watch far really almost let above "
    "girl sometimes mountain cut young talk soon list song being leave family "
    "body music color stand sun questions fish area mark dog horse birds problem "
    "complete room knew since ever piece told usually didnt friends easy heard order "
    "red door sure become top ship across today during short better best however low "
    "hours black products happened whole measure remember early waves reached listen "
    "wind rock space covered fast several hold himself toward five step morning passed "
    "vowel true hundred against pattern numeral table north slowly money map farm pulled "
    "draw voice seen cold cried plan notice south sing war ground fall king town "
    "unit figure certain field travel wood fire upon done english road half ten fly "
    "gave box finally wait correct oh quickly person became shown minutes strong verb "
    "stars front feel fact inches street decided contain course surface produce building "
    "ocean class note nothing rest carefully scientists inside wheels stay green known "
    "island week less machine base ago stood plane system behind ran round boat game "
    "force brought understand warm common bring explain dry though language shape deep "
).split()

_seen = []
for _w in _POOL:
    if _w.isalpha() and _w.islower() and _w not in _seen:
        _seen.append(_w)
assert len(_seen) >= 256, f"word pool has only {len(_seen)} unique words; need >= 256"
WORDS = _seen[:256]
assert len(WORDS) == 256 and len(set(WORDS)) == 256
assert all(w.isalpha() and w.islower() and w.isascii() for w in WORDS)

_INDEX = {w: i for i, w in enumerate(WORDS)}


def encode(data: bytes) -> str:
    """ciphertext bytes -> cover text (space-joined words)."""
    return " ".join(WORDS[b] for b in data)


def decode(text: str) -> bytes:
    """cover text -> ciphertext bytes. Raises coder.NotCoverText on any non-codec word."""
    words = text.strip().split()
    try:
        return bytes(_INDEX[w] for w in words)
    except KeyError as e:
        raise coder.NotCoverText(f"unknown cover word: {e.args[0]!r}") from None


# Model identity, so /health can pin what both ends agree on.
MODEL = "wordmap-256/v1"
import hashlib as _h
DIGEST = _h.sha256(("|".join(WORDS)).encode()).hexdigest()[:16]
