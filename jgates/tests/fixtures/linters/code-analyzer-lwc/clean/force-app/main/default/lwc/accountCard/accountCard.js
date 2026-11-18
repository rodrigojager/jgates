import { LightningElement } from "lwc";

export default class AccountCard extends LightningElement {
    label = "";

    connectedCallback() {
        this.label = "ready";
    }
}
