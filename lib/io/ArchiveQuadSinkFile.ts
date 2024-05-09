import type * as RDF from "@rdfjs/types";
import { createReadStream, createWriteStream } from "fs";
import { DataFactory } from "n3";
import rdfParser from "rdf-parse";
import rdfSerializer from "rdf-serialize";
import { v4 as uuid } from "uuid";
import { IQuadSinkFileOptions, QuadSinkFile } from "./QuadSinkFile";
import streamifyArray = require("streamify-array");
const { namedNode, literal, quad, blankNode } = DataFactory;

export const VS_PREFIX = "https://vsolid.org/properties#" as const;

export const VS = {
  operation: `${VS_PREFIX}operation`,
  delete: `${VS_PREFIX}delete`,
  insert: `${VS_PREFIX}insert`,
  delta_date: `${VS_PREFIX}delta_date`,
  delta_author: `${VS_PREFIX}delta_author`,
  next_delta: `${VS_PREFIX}next_delta`,
  contains_operation: `${VS_PREFIX}contains_operation`,
} as const;

export type VS = typeof VS;

const historyLengths = {
  "scale1": 1,
  "scale10": 10,
  "scale100": 100,
  "scale1_000": 1_000,
  "scale10_000": 10_000,
} as const;

const matchNumberRegex = /\/(\d+)\/?/;

export class ArchiveQuadSinkFile extends QuadSinkFile {
  public constructor(options: IQuadSinkFileOptions) {
    super(options);
    this.generateTestData();
  }

  private getFilePathHelper(iri: string): string {
    const posHash = iri.indexOf("#");
    if (posHash >= 0) {
      iri = iri.slice(0, posHash);
    }

    return super.getFilePath(iri).replace("$.ttl", "");
  }

  private async generateTestData() {
    for (const [key, value] of Object.entries(historyLengths)) {
      const iri = `http://localhost:3000/test/${key}#data`;
      for (let i = 0; i < value; i++) {
        const thing = quad(
          namedNode(iri),
          namedNode("http://example.org/property"),
          literal(`test ${i}`)
        );
        await this.push(iri, thing);
      }
      console.log("");
      console.log("Generated test data for", key);
    }
  }

  public async push(iri: string, quad: RDF.Quad): Promise<void> {
    await super.push(iri, quad);

    const path = this.getFilePathHelper(iri) + ".vSolid";
    const os = await this.getFileStream(path);

    const delta = await this.createDelta(iri, quad);
    delta.forEach(quad => os.write(quad));
  }

  async generateHistoryForThing(iri: string, thing: RDF.Quad, historyLength: number = 50) {
    let headDeltaId : string | null = null;
    const quadstoWrite: RDF.Quad[] = [];

    const path = this.getFilePathHelper(iri) + ".vSolid";
    const os = await this.getFileStream(path);

    for (let i = 0; i < historyLength; i++) {
      const newQuad = quad(
        thing.subject,
        thing.predicate,
        literal(`${thing.object.value} ${i}`)
      );

      const deltaQuads = await this.createDelta(iri, newQuad, VS.insert, false, headDeltaId);
      headDeltaId = deltaQuads[0].subject.value;

      for (const quad of deltaQuads) {
        quadstoWrite.push(quad)
      }
    }

    for (let i = 0; i < historyLength; i++) {
      const newQuad = quad(
        thing.subject,
        thing.predicate,
        literal(`${thing.object.value} ${i}`)
      );

      const deltaQuads = await this.createDelta(iri, newQuad, VS.delete, false, headDeltaId);
      headDeltaId = deltaQuads[0].subject.value;

      for (const quad of deltaQuads) {
        quadstoWrite.push(quad)
      }
    }

    for (const quad of quadstoWrite) {
      os.write(quad);
    }

    await this.writeMetadata(iri, headDeltaId ?? "");
  }

  async readMetadataID(iri: string): Promise<string> {
    const path = this.getFilePathHelper(iri) + ".meta";
    const quads = await this.readQuadsFromFile(path);
    return quads[0]?.object.value ?? "";
  }

  async readQuadsFromFile(path: string) : Promise<RDF.Quad[]> {
    return new Promise((resolve, reject) => {
      const stream = createReadStream(path);
      const rdfStream = rdfParser.parse(stream, { contentType: "text/turtle" });
      const quads: RDF.Quad[] = [];
      rdfStream.on("data", (quad) => {
        quads.push(quad);
      });
      rdfStream.on("end", () => {
        resolve(quads);
      });
      rdfStream.on("error", () => {
        resolve(quads);
      });
    });
  }

  async writeMetadata(iri: string, id: string) {
    return new Promise((res, rej) => {
      const path = this.getFilePathHelper(iri) + ".meta";

      const posHash = iri.indexOf("#");
      if (posHash >= 0) {
        iri = iri.slice(0, posHash);
      }

      const metaData = quad(
        namedNode(iri),
        namedNode(VS.next_delta),
        literal(id)
      );

      const fileStream = createWriteStream(path);
      rdfSerializer
        .serialize(streamifyArray([metaData]), { contentType: "text/turtle" })
        .pipe(fileStream);

      fileStream.on("finish", res);
      fileStream.on("err", rej);
    });
  }

  async createDelta(iri: string, operationQuad: RDF.Quad, operation: VS["insert"] | VS["delete"] = VS["insert"], writeMetadata: boolean = true, headDeltaId: string | null = null): Promise<RDF.Quad[]> {
    const id = uuid();

    const deltaDate = quad(
      namedNode(id),
      namedNode(VS.delta_date),
      literal(new Date().toISOString())
    );

    const metadataId = headDeltaId ?? await this.readMetadataID(iri);
    const nextDeltaID = metadataId == "" ? blankNode() : literal(metadataId);

    const nextDelta = quad(namedNode(id), namedNode(VS.next_delta), nextDeltaID);

    const operations: RDF.Quad[] = [
      quad(
        namedNode(id),
        namedNode(VS.contains_operation),
        this.createOperation(operationQuad, operation)
      ),
    ];

    const delta: RDF.Quad[] = [deltaDate, nextDelta, ...operations];

    if (writeMetadata) await this.writeMetadata(iri, id);

    return delta;
  }

  createOperation(subject: RDF.Quad, type: string): RDF.Quad {
    return quad(subject, namedNode(VS.operation), namedNode(type));
  }
}
