# One image, three roles (router1 / router2 / target) of the multi-hop
# traceroute fixture (#4964, MT-NET-16). See entrypoint.sh for the topology.
FROM alpine:3.22

RUN apk add --no-cache iproute2

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

HEALTHCHECK --interval=2s --timeout=2s --retries=30 CMD test -f /tmp/ready

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
