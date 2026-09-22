# MinIO para CPUs sin x86-64-v2 (p. ej. el "QEMU Virtual CPU" del VPS Quasar).
# La imagen oficial (quay.io/minio/minio) usa glibc de RHEL 9 compilada para
# x86-64-v2 y aborta con "Fatal glibc error" en esos CPUs. El binario oficial
# de MinIO es Go estático y corre en cualquier x86-64: se empaqueta sobre
# Alpine y listo. Misma release que se validó en dl.min.io.
FROM alpine:3.20

ADD https://dl.min.io/server/minio/release/linux-amd64/archive/minio.RELEASE.2024-01-16T16-07-38Z /usr/local/bin/minio
RUN chmod +x /usr/local/bin/minio && mkdir -p /data

EXPOSE 9000 9001
ENTRYPOINT ["/usr/local/bin/minio"]
