"use strict";

/**
 * The "database" — a fixed, seeded dataset built once at startup, so this
 * behaves like a real system of record (same content on every restart), not
 * a generator you re-roll from a UI. `seededRandom` stands in for a real
 * random source deterministically, purely so this file doesn't have to
 * hand-list 150+ rows.
 */

const DIVISION_NAMES = ["Kaduwela", "Colombo Central", "Gampaha", "Jaffna", "Kandy", "Galle", "Matara", "Negombo"];

const FIRST_NAMES = [
  "Nimal", "Sunil", "Kamal", "Priya", "Anura", "Chamari", "Ruwan", "Dilani", "Saman", "Nadeeka",
  "Ajith", "Malini", "Sarath", "Chandra", "Kumari", "Lasantha", "Iresha", "Prasad", "Wasana", "Roshan",
  "Tharindu", "Sanduni", "Chathura", "Nilmini", "Buddhika", "Gayani", "Kasun", "Hasini", "Pradeep", "Anoma",
];
const LAST_NAMES = [
  "Perera", "Fernando", "Silva", "Jayasuriya", "Bandara", "Wickramasinghe", "Gunawardena", "Rathnayake",
  "Dissanayake", "Senanayake", "Kariyawasam", "Weerasinghe", "Abeysekara", "Herath", "Jayasinghe",
  "Karunaratne", "Ekanayake", "Wijesinghe", "Rajapaksha", "Amarasinghe",
];

const OFFICERS_PER_DIVISION = 2;
const VOTERS_PER_DIVISION = 15;

const slugify = name => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const fullName = index => `${FIRST_NAMES[index % FIRST_NAMES.length]} ${LAST_NAMES[(index * 7 + 3) % LAST_NAMES.length]}`;

/** A tiny seeded LCG — deterministic across restarts, unlike Math.random. */
function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}
const rand = seededRandom(42);

const divisions = DIVISION_NAMES.map((name, i) => ({ id: i + 1, name }));

const officers = [];
{
  let index = 0;
  for (const division of divisions) {
    for (let i = 1; i <= OFFICERS_PER_DIVISION; i++, index++) {
      officers.push({
        username: `gn.${slugify(division.name)}${i}`,
        fullName: fullName(index),
        division: division.name,
        divisionId: division.id,
      });
    }
  }
}

const voters = [];
{
  let nicSeq = 850000001;
  let index = 0;
  for (const division of divisions) {
    for (let i = 0; i < VOTERS_PER_DIVISION; i++, index++) {
      const phoneDigits = String(Math.floor(rand() * 1e8)).padStart(8, "0");
      voters.push({
        nic: `${(nicSeq++).toString().padStart(9, "0")}V`,
        fullName: fullName(index + 137), // offset so voter names don't mirror officer names 1:1
        phone: `07${phoneDigits}`,
        division: division.name,
        divisionId: division.id,
      });
    }
  }
}

/**
 * The published API scope — what `GET /api/divisions`, `/gn-officers` and
 * `/voters` actually return. Empty until an operator explicitly picks a
 * scope on the API Configuration page and applies it: "not configured" must
 * mean "nothing to import," never a fabricated default.
 */
const config = {
  divisionIds: new Set(),
  officerUsernames: new Set(),
  voterNics: new Set(),
};

const officerByUsername = new Map(officers.map(o => [o.username, o]));
const voterByNic = new Map(voters.map(v => [v.nic, v]));
const validDivisionIds = new Set(divisions.map(d => d.id));

const getDatabase = () => ({ divisions, officers, voters });

const getConfig = () => ({
  divisionIds: [...config.divisionIds],
  officerUsernames: [...config.officerUsernames],
  voterNics: [...config.voterNics],
});

class ConfigError extends Error {}

/**
 * Publishes the division scope on its own. Officers and voters are still
 * server-side checked against it (below) rather than trusted from the
 * request — a client-side disabled checkbox is a UX nicety, not a guarantee.
 *
 * Removing a division from scope takes its officers/voters with it: they
 * cannot remain published while no longer eligible, so they're pruned here
 * rather than left as an orphaned, silently-invalid publication.
 */
function setDivisions(divisionIds) {
  const divisionIdSet = new Set((divisionIds || []).map(Number));
  for (const id of divisionIdSet) {
    if (!validDivisionIds.has(id)) throw new ConfigError(`Unknown division id ${id}.`);
  }

  for (const username of [...config.officerUsernames]) {
    const officer = officerByUsername.get(username);
    if (!officer || !divisionIdSet.has(officer.divisionId)) config.officerUsernames.delete(username);
  }
  for (const nic of [...config.voterNics]) {
    const voter = voterByNic.get(nic);
    if (!voter || !divisionIdSet.has(voter.divisionId)) config.voterNics.delete(nic);
  }

  config.divisionIds = divisionIdSet;
  return getConfig();
}

/** Publishes the GN officer scope. Each officer's own division must already be published. */
function setOfficers(officerUsernames) {
  const officerUsernameSet = new Set(officerUsernames || []);
  for (const username of officerUsernameSet) {
    const officer = officerByUsername.get(username);
    if (!officer) throw new ConfigError(`Unknown officer "${username}".`);
    if (!config.divisionIds.has(officer.divisionId)) {
      throw new ConfigError(`Officer "${username}" belongs to a division that isn't published yet.`);
    }
  }
  config.officerUsernames = officerUsernameSet;
  return getConfig();
}

/** Publishes the voter scope. Each voter's own division must already be published. */
function setVoters(voterNics) {
  const voterNicSet = new Set(voterNics || []);
  for (const nic of voterNicSet) {
    const voter = voterByNic.get(nic);
    if (!voter) throw new ConfigError(`Unknown voter "${nic}".`);
    if (!config.divisionIds.has(voter.divisionId)) {
      throw new ConfigError(`Voter "${nic}" belongs to a division that isn't published yet.`);
    }
  }
  config.voterNics = voterNicSet;
  return getConfig();
}

function clearConfig() {
  config.divisionIds = new Set();
  config.officerUsernames = new Set();
  config.voterNics = new Set();
  return getConfig();
}

const getPublishedDivisions = () => divisions.filter(d => config.divisionIds.has(d.id)).map(d => ({ name: d.name }));

const getPublishedOfficers = () =>
  officers
    .filter(o => config.officerUsernames.has(o.username))
    .map(o => ({ username: o.username, division: o.division }));

const getPublishedVoters = () =>
  voters
    .filter(v => config.voterNics.has(v.nic))
    .map(v => ({ nic: v.nic, phone: v.phone, division: v.division }));

module.exports = {
  getDatabase,
  getConfig,
  setDivisions,
  setOfficers,
  setVoters,
  clearConfig,
  ConfigError,
  getPublishedDivisions,
  getPublishedOfficers,
  getPublishedVoters,
};
