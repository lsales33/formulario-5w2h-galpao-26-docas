# Roteirizador A→B

Roteirizador origem → destino com busca por endereço ou CEP, rotas alternativas, passo a passo em português e estimativa de custo de combustível.

- `public/`: a página (Leaflet + OpenStreetMap), que só conversa com a API própria.
- `server.js`: servidor Node sem dependências. Ele serve a página e expõe a API abaixo, com cache e limite de consultas por IP.

## API

| Rota | Parâmetros | Retorno |
|---|---|---|
| `GET /api/geocode` | `q`, `near=lat,lng` (opcional) | lista `{lat,lng,title,sub,label}` |
| `GET /api/cep` | `cep` (8 dígitos) | ViaCEP + coordenadas (`precision`: `rua` ou `aproximada`) |
| `GET /api/reverse` | `lat`, `lng` | `{label}` |
| `GET /api/route` | `from=lat,lng`, `to=lat,lng`, `mode=car\|bike\|foot` | `{provider, traffic, routes:[{distance,duration,summary,coords,steps}]}` |
| `GET /healthz` | – | `{ok, provider}` |

## Provedor

| Variável | Efeito |
|---|---|
| *(nenhuma)* | OpenStreetMap: OSRM/FOSSGIS para rotas, Photon/Nominatim para endereços. Gratuito, sem trânsito em tempo real. |
| `GOOGLE_MAPS_API_KEY` | Google Maps Platform: Routes API (com trânsito para carro) e Geocoding API. Se o Google falhar, volta automaticamente para o OSM. |
| `RATE_PER_MIN` | Limite de consultas por IP por minuto (padrão 90). |
| `USER_AGENT` | Identificação enviada aos serviços OSM. |

Para ativar o Google, a chave precisa ter **Routes API** e **Geocoding API** habilitadas e faturamento ativo. Restrinja a chave por API, já que ela fica só no servidor.

## Rodar localmente

```bash
npm start      # http://localhost:3000
npm test       # testa a API com provedores simulados
```
