# Dosti Pakki Expense Apna Apna — Group Trip Expense Splitter & Receipt Scanner

A fast group trip expense manager with camera snapshot capture, AI receipt scanning (photos & PDFs), minimum-payment settlement calculation, and CSV spreadsheet export.

## Core Features

1. **Create a Trip**:
   - Give your trip a name and add everyone's names.
   - All trips are listed on the home page — click any trip to open it immediately.
2. **Add an Expense by Hand**:
   - Pick who paid from the group list, enter the amount, choose a category (`Food & Drink`, `Transport`, `Accommodation`, `Groceries`, `Activities`, `Shopping`, `Other`), and tick who shared it.
   - Optional bill photo: **Take a Snapshot** directly with your camera or **Upload a Photo** from your device.
3. **Scan Receipts (AI)**:
   - Choose who paid, then **Take a Snapshot** of the bill or **Upload one or more photos or PDFs**.
   - Gemini Vision / Document AI reads each receipt's **total, description, category, and date**, then adds it as an expense split equally between everyone.
   - *To change who shared a scanned bill, delete it and add it again by hand (or click "Delete & Re-add by Hand").*
4. **Who Pays Whom (Fewest Payments)**:
   - Calculates the strictly fewest payments needed to settle up everyone's net balance.
   - Tap **"Mark paid"** when someone pays to move it into the **Payments List**, where you can **"Undo"** it at any time.
5. **Export CSV**:
   - Downloads all expenses for the trip as a `.csv` spreadsheet file (UTF-8 with BOM for clean currency symbols in Excel/Google Sheets).

## Running Locally

Double-click `run_trip_splitter.bat` or run:

```bash
cd trip-expense-splitter
node server.js
```

Then open `http://127.0.0.1:8080`.
