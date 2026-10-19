# SE Registration Capacity

Answers "when should we shut down registration?" for each division of the
league. Set a team count per division (from field slots and coaches), load last
season's rosters as expected returners, and let SportsEngine registrations flow
in live. Every division shows how many seats are still open.

```
capacity = teams × roster size
held     = returners who haven't registered yet (Expected + Need to contact)
open     = capacity − registered − held
```

The math lives in `src/lib/capacity.ts`.

- **`/`**: seat counts per division, live over SSE. It shows numbers only, never
  kids' names. The headline names any division that is full or over capacity
  ("Close registration: Majors"); "closing soon" is at or below the threshold
  set under Divisions → Settings.
- **`/admin`** has these tabs:
  - **Players**: edit inline. Tick kids and use **Move to** to change their
    division.
  - **Registrations**: the inbox, a CSV import, and a single-registration form.
  - **Divisions**: teams, roster size, coaches, ages, SE program words, the
    draft board relay, Closed, the returner import and settings.
  - **Activity**: the audit log.

## Run

```sh
pnpm install
cp .env.example .env              # then fill in values
pnpm build
pnpm admin add <username>         # prompts for a password (10+ chars)
pnpm start                        # http://127.0.0.1:3040
pnpm test
```

It is deployed as a **user** systemd unit (`se-registration.service`). After any
change, run `pnpm build && systemctl --user restart se-registration`.
Nginx and TLS: point DNS at the box, then `sudo bash deploy-nginx.sh`.

## How kids get placed

- **Returners** come from last season's rosters, pasted on the Divisions tab
  (Name, Birthdate, Division, Team, optional Next Division). Each kid is placed
  by league age against the division age ranges. A kid stays put while still
  eligible; otherwise they go to the next level up. Without a birthdate, they
  stay in the same division. Kids older than every division are skipped. They
  start as **Expected** and hold a seat. Mark them **Need to contact** (still
  holds a seat; the card shows a best case) or **Not returning** (releases the
  seat).
- **Registrations** are placed in the division whose *SE program words* appear
  in the program the family picked in SportsEngine.
  - A registration that matches an existing kid (by SE id, or by name plus
    birthdate) flips them to **Registered**. Anyone else becomes a new
    Registered player.
  - A registration that matches no division lands in the inbox to be placed by
    hand.
  - A cancellation marks the kid **Withdrawn** and frees the seat.
  - Registrations for another season year are filed and take no seat.
- **Admin moves are pinned.** If a family picked the wrong division, move the
  kid on the Players tab. After that, a resent or re-run registration keeps
  them where the admin put them. Click **Pinned ✕** to let their SE program
  decide again. Every move is in the audit log with who, from, to and the
  reason.
- Kids whose league age is outside their division's range are flagged (filter
  *Age doesn't fit*).

## SportsEngine and the draft board

```
POST {BASE_URL}/webhooks/sportsengine/{SPORTSENGINE_WEBHOOK_TOKEN}
```

This is the one URL to give SportsEngine. Registrations placed in a division
with **Draft board** ticked are relayed to `DRAFT_BOARD_WEBHOOK_URL`, so the
Majors draft board keeps getting its updates. A single-event delivery is
relayed byte-for-byte with its signature header, so the board's HMAC check
still passes once both apps share `SPORTSENGINE_WEBHOOK_SECRET`. A failed relay
shows in the inbox (*Draft board relay failed*) with a **Resend** button.

As on the draft board, `extract()` in `src/lib/sportsengine.ts` is a tolerant
guess until real payloads arrive. Every delivery is stored raw, so you can
tighten the mapping, rebuild, and use *Re-run placement on open items*.

## Shared league login

Admin accounts live in one place for every league tool:
`/home/greg/apps/league-data/auth.db` (`AUTH_DB_PATH`). With
`COOKIE_DOMAIN=.crushworldseries.com`, signing in on any tool signs you in on
all of them, and signing out of one signs you out of all of them. `pnpm admin
add|passwd|remove|list` in either app manages the same accounts.
