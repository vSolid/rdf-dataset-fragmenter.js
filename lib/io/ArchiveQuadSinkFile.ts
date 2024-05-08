
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
    super.push(iri, quad);

    const path = this.getFilePathHelper(iri) + ".vSolid";
    const os = await this.getFileStream(path);

    let delta = await this.createDelta(iri, quad);
    delta.forEach((quad) => {
      os.write(quad);
    });
  }

  async readMetadataID(iri: string): Promise<string> {
    return new Promise((res, rej) => {
      const path = this.getFilePathHelper(iri) + ".meta";

      let stream = createReadStream(path);

      let rdfStream = rdfParser.parse(stream, { contentType: "text/turtle" });

      let quads: RDF.Quad[] = [];

      rdfStream.on("data", (quad) => {
        quads.push(quad);
      });
      rdfStream.on("end", () => {
        let metadataQuad = quads[0];
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

      let metaData = quad(
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

  async createDelta(iri: string, test: RDF.Quad): Promise<RDF.Quad[]> {
    const id = uuid();

    let deltaDate = quad(
      namedNode(id),
      namedNode(VS.delta_date),
      literal(new Date().toISOString())
    );

    let metadateID = await this.readMetadataID(iri);
    let nextDeltaID = metadateID == "" ? blankNode() : literal(metadateID);

    let nextDelta = quad(namedNode(id), namedNode(VS.next_delta), nextDeltaID);

    let operations: RDF.Quad[] = [
      quad(
        namedNode(id),
        namedNode(VS.contains_operation),
        this.createOperation(test, VS.insert)
      ),
    ];

    let delta: RDF.Quad[] = [deltaDate, nextDelta, ...operations];

    await this.writeMetadata(iri, id);

    return delta;
  }

  createOperation(subject: RDF.Quad, type: string): RDF.Quad {
    let operation = quad(subject, namedNode(VS.operation), namedNode(type));

    return operation;
  }

  close(): Promise<void> {
    return super.close();
  }
}
