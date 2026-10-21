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

Each next step carries an `action`, and its button applies it:

| action | button | how |
|---|---|---|
| `create_task` | Créer la tâche | `ZOHO.CRM.API.insertRecord`, linked to the account (and the contact the step names) |
| `close_task` | Fermer la tâche, then Confirmer | `updateRecord` Status set to the label of the option whose actual value is `Completed` ("Achevé", read from the field's options), the reason added to the description |
| `update_task` | Mettre à jour la tâche | `updateRecord` Due_Date (and Subject when the step gives one), the reason added to the description |
| `decline_quote` | Marquer refusé, then Confirmer | the function's `quote_decline` action: Books marks the quote declined and gets a comment hidden from the client; the CRM Potential follows to "Perdu" through Books' own sync |
| `revise_quote` | Modifier dans Books | opens the quote's edit page in Books; the rep makes the change |

A picklist is written with the option's label, not its actual value: sent the
actual value `Completed`, Zoho stores a stray word beside "Achevé" and leaves the
task open, with no Closed_Time.

Task actions run as the signed-in CRM user, so Zoho checks their permissions and
records them as the author; each first reads the task, so a task closed since
the card was written is reported, not reopened. A card written before actions
existed has steps without `action`: they are `create_task`.

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

## The card at the top of the page (business card extension)

`app/card.html` is the same widget with `data-layout="compact"`: header, alerts and
figures stay on show, and the synthesis, key points and next steps share one panel
under tabs. It runs as a **Business Card Widget**, which Zoho draws on the standard
Account page under the owner/phone card and the Potentials / Next Action / Contacts
row, above the field sections. A Business Card Widget exists only inside an
extension, so it does not appear under Developer Hub → Widgets:

| Setting | Value |
|---|---|
| Extension | *Resume IA du compte* (namespace `resumeiatestemplacement`), installed privately in the org |
| Developer console | Setup → Marketplace → Extension Builder → workspace *affichez* |
| Connected app | `bctest`, internal hosting, zip `dist/resume-ia-card.zip` (a copy of `dist/zoho-widget.zip`) |
| Component | Business Card Widget, module Accounts, start URL `/card.html` |

Three limits shape the compact layout:

- **500 px, at most.** Zoho caps the frame height for this slot. Only the tab panel
  scrolls; the frame never does.
- **Zoho pads the frame** 15 px top and bottom and 20 px at the sides, inside the
  height it is given (`box-sizing: border-box`). The card therefore asks for its
  height plus 30 (`COMPACT_INSET`), and its own CSS caps it at 466 px. Ask for the
  bare height and the bottom line is cut off.
- **No profile setting.** The extension shows the slot to everyone it is installed
  for, so `PILOT_PROFILES` in `widget.js` limits it: for any other profile the card
  draws nothing and asks no height, and Zoho keeps the slot hidden. An empty list
  shows it to everyone.

To update: pack, copy `dist/zoho-widget.zip` to `dist/resume-ia-card.zip`, then in
the developer console Connected Apps → `bctest` → *Replace existing file*, and
Publish with a release note. The org keeps running the installed version until an
admin opens the extension's install URL and upgrades it (the Terms of Service and
data-access boxes are asked again on every upgrade).

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
