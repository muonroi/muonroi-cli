/**
 * Angular test setup.
 *
 * Spike findings:
 * 1. zone.js MUST be imported BEFORE Angular TestBed.
 * 2. In jsdom environment (browser-like), import the standard zone.js bundle.
 * 3. TestBed.initTestEnvironment() must be called once to initialize the
 *    Angular testing infrastructure before any test uses TestBed.
 */

// Step 1: zone.js before any Angular import.
import "zone.js";
// zone-testing is required for fakeAsync() / tick() in Angular tests.
import "zone.js/testing";

// Step 2: Initialize Angular TestBed with BrowserDynamicTestingModule.
import { TestBed } from "@angular/core/testing";
import { BrowserDynamicTestingModule, platformBrowserDynamicTesting } from "@angular/platform-browser-dynamic/testing";

TestBed.initTestEnvironment(BrowserDynamicTestingModule, platformBrowserDynamicTesting(), {
  teardown: { destroyAfterEach: true },
});
