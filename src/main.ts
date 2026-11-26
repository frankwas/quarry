import { bootstrapApplication } from "@angular/platform-browser";
import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";
import { relabelShortcutsForMac } from "./app/core/platform";

bootstrapApplication(AppComponent, appConfig)
  .then(() => relabelShortcutsForMac(document.body))
  .catch((err) => console.error(err));
