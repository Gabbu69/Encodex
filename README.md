# Encodex

Local desktop application for capturing supported medical forms from a phone and copying only explicitly selected reviewed values into an existing encoding system.

Supported supplied form templates:

- Urinalysis laboratory result
- Pregnancy test laboratory result
- X-Ray / Radiology result
- Medical Certificate

## Run Locally

Requirements: Windows laptop, Node.js 24 or later, and a phone connected to the same private local network as the laptop.

```powershell
npm install
npm run build
npm start
```

On first launch, create an app password. The encrypted workspace cannot be opened without that password.

## Workflow

1. Import an approved patient master `.csv` or `.xlsx` file with official name, PhilHealth ID, and birthdate columns when correction or PIN lookup is needed.
2. Choose `New Capture`, the form template, and a capture profile such as `Name Only`, or create a custom field selection. Leave `Continuous phone scanning` enabled when processing many papers with the same setup.
3. Scan the QR code once with the phone and submit the first photograph. In continuous mode, tap `Capture Next Paper` after each successful upload to continue without rescanning a QR code.
4. On the laptop, adjust alignment if needed and confirm only the selected fields. Typed selected fields are suggested automatically when a queued photo is opened.
5. Use each confirmed field's copy button to paste into the official system, or explicitly export reviewed fields to CSV.
6. Once official entry is confirmed, select `Mark Entered And Delete` to remove the local case and image.

## Phone Capture Connection

1. Connect the laptop and phone to the same private network. A password-protected hotspot created by the laptop is the preferred current setup.
2. Start Encodex on the laptop, unlock it, and create a new capture after choosing the form and selected fields.
3. Scan the displayed QR code using the phone camera. The phone opens a short-lived local upload page.
4. Photograph the document and submit it from the phone; review and copying continue on the laptop.
5. For continuous mode, select `Capture Next Paper` on the phone after each upload. Each sent photo creates a separate case using exactly the same capture profile and selected fields; you may review as you go or queue several papers first.

The current QR upload link uses local `http://` transport. Do not upload real patient documents over shared Wi-Fi unless the facility has explicitly approved this transport risk. Use fabricated or redacted records for shared-network testing until HTTPS upload support is added or an approved procedure is in place.

If the phone cannot open the QR link, confirm both devices are on the same network, the Encodex workspace is unlocked, the link was created within the last 10 minutes, and Windows Firewall permits the app on the approved private network.

## Privacy Boundaries

- Only the four configured layouts are supported: Urinalysis, Pregnancy Test, X-Ray / Radiology, and Medical Certificate.
- Only fields selected before capture can be retained, copied, or exported. `Name Only` stores no clinical result fields.
- Typed-form OCR runs locally on selected crop regions only. Medical-certificate handwriting is manual-first.
- Official corrected names and PhilHealth IDs can only be populated from a confirmed patient-master match using a manually verified birthdate; birthdate is not printed on the supplied forms.
- Records, approved patient-list data, and temporary images are encrypted at rest; the current phone upload connection is not HTTPS-encrypted in transit.
- Source photographs are deleted on official-entry completion or after seven days.
- Clipboard values clear automatically after 60 seconds.
- Plaintext CSV files should be deleted after successful transfer to the official database.

Use fabricated or redacted forms during evaluation. Processing real patient records should begin only after facility approval of storage, transfer, retention, and export procedures.

## Developer Checks

```powershell
npm run typecheck
npm test -- --pool=threads --maxWorkers=1
npm run build
npm audit
```
