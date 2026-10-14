# Résumé IA — Zoho CRM widget

Related-list widget for the **Account** page in Zoho CRM. It shows the AI
relationship summary built by the `account-summary` edge function
(`supabase/functions/account-summary/`) and lets the rep generate it, open the
cited records and turn a suggested next step into a CRM task.

Plain HTML/CSS/JS, no build step. `app/` is what Zoho serves.

## How it talks to the backend

The widget never calls Supabase directly. It calls the Zoho **Connection**
`affichez_resume_ia` (`ZOHO.CRM.CONNECTION.invoke`), and Zoho adds the
`x-summary-key` header on its side, so the key is not in the widget code.

| Setting | Value |
|---|---|
| Custom service | `Affichez Resume IA` (link name `affichezresumeia`), API Key, parameter type **Header**, key `x-summary-key` |
| Connection link name | `affichez_resume_ia` (constant `CONNECTION` in `app/js/widget.js`), shared with all users |
| Connection value | the function's `SUMMARY_API_KEY` secret |
| Endpoint | `https://auyfucbskylougsmmrks.supabase.co/functions/v1/account-summary` |

Tasks are created with `ZOHO.CRM.API.insertRecord` as the signed-in CRM user,
linked to the account (and to the contact when the step names one).

## Package and install

```powershell
cd zoho-widget
npx zoho-extension-toolkit validate
npx zoho-extension-toolkit pack        # → dist/zoho-widget.zip
```

1. Setup → Developer Hub → Widgets → Create: name *Résumé IA du compte*, type
   **Related List**, hosting **Zoho**, upload `dist/zoho-widget.zip`, index page
   `/widget.html` (Zoho's base URL already ends in `/app`; `/app/widget.html`
   gives "Page Not Found").
2. Accounts → a record → Add Related List → Widgets → *Résumé IA du compte* →
   Install. Then the related-list organizer (icon next to "Related List") →
   move it right under Notes, which Zoho keeps first.

To update: pack again, then Widgets → *Résumé IA du compte* → Change → the new
zip → Save. Check the "Widget updated successfully" toast and the Last Modified
time; a save that did not go through keeps serving the old files.

## The card at the top of the page (Canvas)

On the standard Account page Zoho keeps Notes as the first related list and
puts every field section above the related lists, so the card cannot be the
first thing on screen there. The Canvas detail page **Comptes - Resume IA
pilote v2** (Setup → Canvas → Detail View, module Comptes, layout Standard)
puts it first:

- Overview tab: the *Résumé IA du compte* related list, full width, then one
  vertical flex holding Compte Owner and Phone, the seven field sections in the
  layout's order, and the related lists in the standard page's order.
- Each section is a title text plus a flex with Auto Column = 2 (two fields per
  row). Where the standard page leaves a column short, a text holding a single
  zero-width space keeps the next field in the right column.
- Heights are Fluid: the card grows with the summary and pushes the page down.
- Styling copies the standard page: labels 187 px, right-aligned, `#616E88`;
  values regular `#313949`; rows 44 px apart; white cards (radius 8) 12 px apart
  on `#EEF1F9`. Quick Edit Mode is on for every field.

A canvas is a copy, not the layout. A field or related list added to the
Comptes layout later appears on the canvas only once someone adds it here, and
arrives with Canvas's default look: copy the label, value and holder styles of a
neighbouring field. Canvas Assignment decides who sees it; until a profile is
assigned, everyone keeps the standard page.

Things the canvas cannot reproduce: the related-list navigator on the left, the
Next Action card, Hide Details, the website and tags in the header, and the "Send
for Zoho Sign" button.

The editor's Preview (the play icon next to the zoom level) is not the record
page. It prints N/A for an empty value where the record page prints a hyphen
(the standard page draws a grey dash icon), it does not run Quick Edit, and it
does not always load the widget. Judge a change on a record, as a user of an
assigned profile.

The widget draws its own 20 px side inset: on both pages Zoho gives the frame the
full width of the card.
