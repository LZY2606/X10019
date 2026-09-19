import { recordTimezoneEvidence } from "./tz-evidence-lib.mjs"

export default function globalSetup() {
  recordTimezoneEvidence("main")
}
