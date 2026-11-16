---
name: sri-invoice-parsing
description: Skill for parsing and extracting invoice data from Ecuador SRI (Servicio de Rentas Internas) web portal, including PrimeFaces table scraping, XML download management, and CSV export.
---

# SRI Invoice Parsing

## Context

The SRI (Servicio de Rentas Internas) is Ecuador's tax authority. Their online portal at `srienlinea.sri.gob.ec` uses **PrimeFaces** (a JSF framework) to render invoice tables.

## Table Structure

Invoice tables in the SRI portal use PrimeFaces components:

- Rows have `data-ri` attributes (Row Index).
- Cells contain mixed content: RUC + company name in the same cell, separated by `<br>` tags.
- XML download links may be: `<a id="...lnkXml...">`, `<img src="...xml.gif">` inside an anchor, or `<a>` with text "XML".

## Data Extraction Patterns

### Invoice Number
Pattern: `\d{3}-\d{3}-\d{9,}` (e.g., `001-001-000000123`)

### RUC (Tax ID)
Pattern: `\b\d{13}\b` (exactly 13 digits)

### Dates
Pattern: `\d{2}/\d{2}/\d{4}` (DD/MM/YYYY format)

### Monetary Values
Pattern: `^\d{1,3}([.,]\d{3})*[.,]\d{2}$`
- Found from right-to-left in the row.
- Order (from right): Total, IVA, Subtotal.

## Text Cleaning

SRI cells often contain:
- `<br>` tags between RUC and company name.
- Inline `<script>` and `<style>` tags.
- Multiple whitespace characters.

The `clean()` function handles all of these by:
1. Replacing `<br>` with spaces.
2. Removing script/style tags.
3. Stripping remaining HTML tags.
4. Normalizing whitespace.

## Pagination

The SRI uses PrimeFaces paginator:
- Next button: `.ui-paginator-next`
- Disabled state: `.ui-state-disabled` class on the button.
- Wait 3 seconds after clicking next for the AJAX request to complete.

## File Naming Convention

Default format: `{RUC}_{DD_MM_YYYY}_{SECUENCIAL}.xml`

Example: `1790016919001_15_07_2025_001001000000456.xml`

## Security Considerations (ISO/IEC 27001)

- Only allow downloads from `sri.gob.ec` domains.
- Sanitize filenames to prevent path traversal attacks.
- Escape HTML when rendering invoice data to prevent XSS.
- Validate RUC format before processing.
