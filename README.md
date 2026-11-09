# IIIT Bhubaneswar Mess Management System

Full-stack JavaScript app: Node.js backend + SQLite + plain HTML/CSS/JS frontend. **No npm dependencies, no Python.**

## Run
Requires Node.js 22.13 or later.

    cp .env.example .env      # Windows: Copy-Item .env.example .env
    # edit .env: set ADMIN_ID and ADMIN_PASSWORD
    npm start                 # open http://localhost:8000

## Features
- Student registration/login (scrypt-hashed passwords, HttpOnly session cookie)
- Weekly menu (staff can edit)
- Skip meals from tomorrow onwards; skipped meals reduce the monthly bill
- Monthly bill + **Pay Now** (simulated: instantly marks the month paid and shows the paid amount; the month is then locked)
- Meal feedback (old feedback auto-deleted after FEEDBACK_KEEP_WEEKS)
- Staff panel: collected/pending totals, per-student status, manual "Mark paid", menu editing, feedback view

## Docker
    docker build -t iiit-mess .
    docker run --rm -p 8000:8000 --env-file .env -v messdata:/data iiit-mess

## Notes
- Meal prices come from BREAKFAST_PRICE / LUNCH_PRICE / DINNER_PRICE in .env.
- Pay Now is a simulation. For real money, add a payment gateway and verify payments server-side.
- Never commit `.env` or `mess.db` (both are in .gitignore).
