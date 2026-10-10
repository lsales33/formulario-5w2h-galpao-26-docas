# Roteirizador A→B

Roteirizador origem → destino para veículos de carga (Van, Toco, Caminhão truck e Carreta), com busca por endereço ou CEP, rotas alternativas, passo a passo em português e estimativa de custo de diesel.

- `public/`: a página (Leaflet + OpenStreetMap), que só conversa com a API própria.
- `server.js`: servidor Node sem dependências. Ele serve a página e expõe a API abaixo, com cache e limite de consultas por IP.

## API

| Rota | Parâmetros | Retorno |
|---|---|---|
| `GET /api/geocode` | `q`, `near=lat,lng` (opcional) | lista `{lat,lng,title,sub,label}` |
| `GET /api/cep` | `cep` (8 dígitos) | ViaCEP + coordenadas (`precision`: `rua` ou `aproximada`) |
| `GET /api/reverse` | `lat`, `lng` | `{label}` |
| `GET /api/route` | `from=lat,lng`, `to=lat,lng`, `vehicle=van\|toco\|truck\|carreta`, `h`, `l`, `t`, `axles`, `tolls=avoid` | `{provider, truckRules, tollsAvoided, routes:[{distance,duration,summary,coords,steps}]}` |
| `GET /api/config` | – | provedores ativos e medidas padrão dos veículos |
| `GET /healthz` | – | `{ok, geocoder, routing}` |

## Provedores

| Variável | Efeito |
|---|---|
| `ORS_API_KEY` | **Rotas de caminhão** pelo OpenRouteService (`driving-hgv`): respeitam altura, comprimento, peso e carga por eixo informados, e podem evitar pedágios. Chave gratuita em openrouteservice.org (cerca de 2.000 rotas/dia). Se o ORS falhar, o serviço volta para o OSRM. |
| *(sem `ORS_API_KEY`)* | Rotas em vias para carro (OSRM/FOSSGIS), com tempo ajustado à velocidade do veículo. **Não** verifica restrições de caminhão, e a tela avisa isso. |
| `GOOGLE_MAPS_API_KEY` | Busca de endereços pelo Google Geocoding (opcional; o padrão é Photon/Nominatim). |
| `RATE_PER_MIN` | Limite de consultas por IP por minuto (padrão 90). |
| `USER_AGENT` | Identificação enviada aos serviços OSM. |

### Medidas padrão (editáveis na tela)

| Veículo | Altura | Compr. | PBT | Eixos | Consumo |
|---|---|---|---|---|---|
| Van | 2,7 m | 6,0 m | 3,5 t | 2 | 9,0 km/l |
| Toco | 3,8 m | 10,0 m | 16 t | 2 | 5,0 km/l |
| Caminhão (truck) | 4,2 m | 14,0 m | 23 t | 3 | 3,8 km/l |
| Carreta | 4,4 m | 18,6 m | 45 t | 5 | 2,5 km/l |

São valores típicos de mercado, não de um modelo específico. Pedágio (cobrado por eixo) não entra no custo.

## Rodar localmente

```bash
npm start      # http://localhost:3000
npm test       # testa a API com provedores simulados
```
