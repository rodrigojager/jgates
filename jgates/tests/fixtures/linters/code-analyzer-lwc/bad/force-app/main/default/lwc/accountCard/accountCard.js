import { LightningElement } from "lwc";

export default class AccountCard extends LightningElement {
    label = "";

    connectedCallback() {
        setTimeout(() => {
            this.label = "ready";
        }, 100);
    }
}
