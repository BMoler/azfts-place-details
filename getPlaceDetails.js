import fetch from "node-fetch";
import { google } from "googleapis";
import { authorize } from "./authenticate.js";
import { Builder, By, Key, until } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

const spreadsheetId = "1kydqwxT96Iz2mgcPwWRGe4Cp2rg8APO4_X3Q0gmC0jI"; // Replace with your spreadsheetID
const tabName = "Address Delimiter"; // The name of your spreadsheet tab found at the bottom
const sheetsApiKey = "API KEY"; // Use the google developer dashboard to get your google sheets API key
const mapsApiKey = "API KEY"; // Use the google developer dashboard to get your google maps API key

const sheets = google.sheets("v4");

const sheetsURL =
  "https://sheets.googleapis.com/v4/spreadsheets/" +
  spreadsheetId +
  "/values/" +
  tabName +
  "?alt=json&key=" +
  sheetsApiKey;

// Retrieves the Google sheet data from the sheetsURL
async function getGoogleSheet() {
  let response = await fetch(sheetsURL);
  let data = await response.json();
  const output = data.values.map((row) =>
    // Get indices 1 - 3 for the data
    row.filter((cell, index) => (index < 4 && index > 0 ? true : false))
  );
  const categories = ["district", "name", "address"];
  const locations = output
    .slice(2)
    .map((location, index) =>
      categories.reduce(
        (obj, key, index) => ({ ...obj, [key]: location[index] }),
        {}
      )
    );
  return locations;
}

// Function to get the addresses from the spreadsheet after the place details have been added
async function getGoogleSheetAddresses() {
  let response = await fetch(sheetsURL);
  let data = await response.json();
  const output = data.values.map(
    // Index is 6 here because thats where the addresses are located
    (row) => row.filter((cell, index) => (index === 6 ? true : false))[0]
  );
  return output.slice(2);
}

// Calls the google places API to retrieve a list of place IDs for each given data point from the spreadsheet
// Google's APIs only allow you to request 100 per second, so this function waits a second between each 100 requests
async function getPlaceIds(locations) {
  const placeURL =
    "https://maps.googleapis.com/maps/api/place/findplacefromtext/json?";
  const batchSize = 100;
  const delay = 1000; // 1 second delay between batches

  const batches = [];
  for (let i = 0; i < locations.length; i += batchSize) {
    const batch = locations.slice(i, i + batchSize).map((location) => {
      const placeName = location.name
        ? location.name
            .replace(/[^\w\s]/gi, "")
            .split(" ")
            .join("%20") + "%20"
        : "";
      const placeAddress = location.address
        ? location.address
            .replace(/[^\w\s]/gi, "")
            .split(" ")
            .join("%20")
        : "";
      let placeInfoURL = "";

      if (location.name && location.address) {
        placeInfoURL =
          placeURL +
          "input=" +
          placeName +
          placeAddress +
          "&inputtype=textquery" +
          "&key=" +
          mapsApiKey;
      } else if (location.name) {
        placeInfoURL =
          placeURL +
          "input=" +
          placeName +
          "&inputtype=textquery" +
          "&key=" +
          mapsApiKey;
      } else if (location.address) {
        placeInfoURL =
          placeURL +
          "input=" +
          placeAddress +
          "&inputtype=textquery" +
          "&key=" +
          mapsApiKey;
      } else {
        return "";
      }

      return fetch(placeInfoURL)
        .then((response) => response.json())
        .then((json) => (json.candidates[0] ? json.candidates[0].place_id : ""))
        .catch((error) => {
          console.error(
            `Failed to fetch place IDs for URL "${placeInfoURL}":`,
            error
          );
          return "";
        });
    });
    batches.push(Promise.all(batch));
    await new Promise((resolve) => setTimeout(resolve, delay)); // Wait for delay between batches
  }

  const results = await Promise.all(batches);
  const placeIds = results.flat();
  return placeIds;
}

// This function retrieves all the relevant details from a list of placeIDs.
// This includes the name, address, city, zip code, county, and longitude and latitude
// ***NOTE*** Running this function does cost money. The current place details API
// rate is $0.017 per API call. For a list of 3000 places, this came out to be about
// $50. Google gives you a free $200 every month for API calls so I didn't have to pay out of pocket.
async function getPlaceDetails(placeIds) {
  const placeURL = "https://maps.googleapis.com/maps/api/place/details/json?";
  const batchSize = 100;
  const delay = 1000; // 1 second delay between batches

  const batches = [];
  for (let i = 0; i < placeIds.length; i += batchSize) {
    const batch = placeIds.slice(i, i + batchSize).map((placeId) => {
      const placeDetailsURL =
        placeURL +
        "place_id=" +
        placeId +
        "&fields=address_components%2Cformatted_address%2Cgeometry%2Cname" +
        "&key=" +
        mapsApiKey;

      if (placeId === "") {
        return ["", "", "", "", "", ""];
      }

      return fetch(placeDetailsURL)
        .then((response) => response.json())
        .then((json) => {
          const result = [
            json.result.name,
            json.result.formatted_address,
            "",
            "",
            "",
            JSON.stringify([
              json.result.geometry.location.lat,
              json.result.geometry.location.lng,
            ]),
          ];
          json.result.address_components.forEach((component) => {
            if (component.types.includes("locality")) {
              result[2] = component.long_name;
            } else if (
              component.types.includes("administrative_area_level_2")
            ) {
              result[3] = component.long_name;
            } else if (component.types.includes("postal_code")) {
              result[4] = component.long_name;
            }
          });
          return result;
        })
        .catch((error) => {
          console.error(
            `Failed to fetch place IDs for URL "${placeDetailsURL}":`,
            error
          );
          return ["", "", "", "", "", ""];
        });
    });
    batches.push(Promise.all(batch));
    await new Promise((resolve) => setTimeout(resolve, delay)); // Wait for delay between batches
  }

  const results = await Promise.all(batches);
  const placeDetails = results.flat();
  return placeDetails;
}

// This function updates the google sheet given an array of data and a range
// for example A1:C5. Users will need to authenticate in order to write to a
// spreadsheet they own
async function updateGoogleSheet(auth, data, range) {
  const request = {
    spreadsheetId: spreadsheetId,
    range: "Address Delimiter!" + range,
    valueInputOption: "USER_ENTERED",
    resource: {
      values: data,
    },
    auth: auth,
  };

  try {
    const response = (await sheets.spreadsheets.values.update(request)).data;
    console.log(JSON.stringify(response));
  } catch (err) {
    console.error(err);
  }
}

// This function uses selenium to enter addresses into the bplant.org ecoregion locator.
// It returns an array of ecoregions for the given address.
async function getEcoregions(address) {
  const options = new chrome.Options();
  options.addArguments("--headless"); // Uncomment this line to run Chrome in headless mode
  const driver = await new Builder()
    .forBrowser("chrome")
    .setChromeOptions(options)
    .build();
  let ecoregions = [];

  try {
    await driver.get("https://bplant.org/ecoregion_locator.php");
    await driver
      .findElement(By.name("new_location"))
      .sendKeys(address, Key.RETURN);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const map = await driver.findElement(By.id("map"));
    const actions = driver.actions({ bridge: true });
    await actions.move({ origin: map }).click().perform();
    await driver.wait(until.elementLocated(By.className("levels")), 10000);

    const ecoregionElements = await driver.findElements(
      By.xpath("//*[contains(@class, 'levels')]//li[position() > 1]")
    );
    for (const ecoregionText of ecoregionElements) {
      const ecoregion = await ecoregionText.getText();
      ecoregions.push(ecoregion);
    }
  } finally {
    await driver.quit();
  }

  return ecoregions;
}

//This function will get the ecoregions for a given list of addresses.
async function processAddresses(addresses, auth) {
  let results = [];
  let row = 3;

  for (const address of addresses) {
    if (address == "") {
      results.push("");
    } else {
      const ecoregions = await getEcoregions(address);
      results.push(ecoregions);
    }
    await updateGoogleSheet(auth, results, "O" + row + ":R" + row);
    results = [];
    row++;
  }
}

async function main() {
  const auth = await authorize();

  // It is recommended to run these functions first to update the google sheet
  // with the place details. (comment these functions out second and run main)
  const placeIds = await getPlaceIds(locations);
  const placeDetails = await getPlaceDetails(placeIds);
  await updateGoogleSheet(auth, placeDetails, "F3:K3325");

  // Run theses functions second to get the ecoregions for the updated
  // place details. (comment these functions out first and run main)
  const addresses = await getGoogleSheetAddresses();
  const slicedAddresses = addresses.slice(3270);
  await processAddresses(slicedAddresses, auth);
}

main();
