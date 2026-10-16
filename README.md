# TripSplit AI — Group Trip Expense Splitter & Receipt Scanner

A fast, PIN-protected group trip expense manager with AI receipt scanning (photos & PDFs), minimum-payment settlement calculation, and CSV spreadsheet export.

## Core Features

1. **Create a Trip & PIN Lock**:
   - Give your trip a name, add everyone's names, and set a PIN (starts as `0000`).
   - All trips are listed on the home page, and each trip asks for its PIN before opening.
2. **Add an Expense by Hand**:
   - Pick who paid from the group list, enter the amount, choose a category (`Food & Drink`, `Transport`, `Accommodation`, `Groceries`, `Activities`, `Shopping`, `Other`), and tick who shared it.
   - Attaching a photo of the bill is optional (and can be viewed anytime from the expense list).
3. **Scan Receipts (AI)**:
   - Choose who paid, then upload one or more photos or PDFs.
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
python server.py
```

Then open `http://localhost:8080`.
