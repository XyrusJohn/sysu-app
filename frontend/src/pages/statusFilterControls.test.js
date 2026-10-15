import {readFileSync} from "node:fs";
import {JSDOM} from "jsdom";
import {describe, expect, it} from "vitest";

const html = readFileSync("dashboard.html", "utf8");

describe("All shipment status filters", () => {
    it("shows only Delivered and Cancelled filters", () => {
        const {window} = new JSDOM(html);
        const delivered = window.document.getElementById("sapTabDelivered");
        const buttons = [...delivered.parentElement.querySelectorAll("button")];

        expect(buttons.map(button => button.id)).toEqual(["sapTabDelivered", "sapTabCancelled"]);
        expect(buttons[1].textContent).toContain("Cancelled");
        window.close();
    });
});
