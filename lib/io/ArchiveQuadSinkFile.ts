import type * as RDF from "@rdfjs/types";
import { createReadStream, createWriteStream } from "fs";
import { DataFactory } from "n3";
import rdfParser from "rdf-parse";
import rdfSerializer from "rdf-serialize";
import type { Writable } from "stream";
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

const longHistories = [
  "00000000000000000933",
  "00000000000000001129",
  "00000002199023256077",
  "00000010995116278291",
  "00000024189255811254"
];

const matchNumberRegex = /\/(\d+)\/?/;

export class ArchiveQuadSinkFile extends QuadSinkFile {
  public constructor(options: IQuadSinkFileOptions) {
    super(options);
  }

  protected attemptLog(newLine?: boolean | undefined): void {
    return super.attemptLog(newLine);
  }

  protected getFilePath(iri: string): string {
    return super.getFilePath(iri);
  }

  private getFilePathHelper(iri: string): string {
    const posHash = iri.indexOf("#");
    if (posHash >= 0) {
      iri = iri.slice(0, posHash);
    }

    return super.getFilePath(iri).replace("$.ttl", "");
  }

  protected getFileStream(path: string): Promise<Writable> {
    return super.getFileStream(path);
  }

  public async push(iri: string, quad: RDF.Quad): Promise<void> {
    await super.push(iri, quad);

    const path = this.getFilePathHelper(iri) + ".vSolid";
    const os = await this.getFileStream(path);

    const delta = await this.createDelta(iri, quad);
    delta.forEach(quad => os.write(quad));

    const match = iri.match(matchNumberRegex);

    if (match?.[1] && longHistories.includes(match[1].toString())) {
      await this.generateHistoryForThing(iri, quad, 500);
    }
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
    return new Promise((res, rej) => {
      const path = this.getFilePathHelper(iri) + ".meta";

      const stream = createReadStream(path);

      const rdfStream = rdfParser.parse(stream, { contentType: "text/turtle" });

      const quads: RDF.Quad[] = [];

      rdfStream.on("data", (quad) => {
        quads.push(quad);
      });
      rdfStream.on("end", () => {
        const metadataQuad = quads[0];
        if (metadataQuad) {
          res(metadataQuad.object.value);
        } else {
          res("");
        }
      });
      rdfStream.on("error", () => {
        res("");
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
